/**
 * adapter.ts — the DeepSeek Harness seat.
 *
 * 移植自 Squad 2.x packages/seat-dsh/src/index.ts @ 8dcb903
 * 改动：
 * - 心跳插件以内置源码写到数据目录（见 heartbeat.ts），不再依赖磁盘上的 .ts 源文件。
 * - prompt 走标准输入（`dsh --profile headless -`，见 dsh headless --help）。
 * - 找 dsh：先看设置里的 dsh 路径，再看环境变量 SQUAD_DSH_BIN，最后找 PATH 上的 dsh。
 *   dsh 常常不在 PATH 上——用 `node …/bin.js` 跑的人通常没链过。
 * - 连接的模型、端点和思考强度写进补丁（patch.ts，原样搬），密钥只走环境变量。
 *
 * A seat is a fresh `dsh --profile headless` child, exactly like the other two
 * backends: running it in-process would hand it Squad's own context, the
 * opposite of what a seat is.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reasoningEffortsFor } from "../../../shared/reasoning-effort.ts";
import {
  deferredRun,
  refusedRun,
  runCliSeat,
  SEAT_SILENCE_LIMITS,
  type ResolvedCommand,
  type SeatRun,
} from "../../seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest } from "../types.ts";
import { buildDshArgv } from "./argv.ts";
import { ensureHeartbeatModule } from "./heartbeat.ts";
import { buildDshPatch, COMPAT_API_KEY_ENV, delegationOffRows, heartbeatRows } from "./patch.ts";
import { readDshOutput } from "./stream.ts";

/** The profile a seat boots. It must answer one task and exit. */
const PROFILE = "headless";

export interface DshAdapterOptions {
  readonly resolve: (name: string) => ResolvedCommand;
  /** Where the heartbeat module is written. */
  readonly stateDir: string;
  /** The path set in Squad's settings, read at each start so a change reaches the next turn. */
  readonly configuredCommand?: (() => string | undefined) | undefined;
  /** The environment variable naming the dsh executable, when dsh is not on PATH. */
  readonly binVariable?: string;
}

export function createDshAdapter(options: DshAdapterOptions): SeatAdapter {
  const binVariable = options.binVariable ?? "SQUAD_DSH_BIN";
  const locate = (): ResolvedCommand => {
    // A blank setting is "not set": it must not hide the environment variable.
    const setting = (options.configuredCommand?.() ?? "").trim();
    const configured = setting !== "" ? setting : (process.env[binVariable] ?? "").trim();
    try {
      return options.resolve(configured === "" ? "dsh" : configured);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}` +
          `（dsh 不在 PATH 上时，到「设置」里填 dsh 的完整路径，` +
          `或者 DeepSeek Harness 的 apps\\cli\\lib\\bin.js。）`,
        { cause: error },
      );
    }
  };

  return {
    backend: "dsh",
    // The headless profile takes one task and nothing else: no system-prompt
    // argument, and (as 2.x ran it) no continued session.
    capabilities: { persona: false, resume: false },
    locate,
    start(request: SeatRequest): SeatRun {
      if (request.persona !== undefined) return refusedRun("⚠️ dsh 不支持单独的 persona；应当把它写进 prompt。");
      let command: ResolvedCommand;
      try {
        command = locate();
      } catch (error) {
        return refusedRun(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
      }
      const connection = request.connection?.connection;
      const modelId = (connection?.modelId ?? "").trim();
      const effort = request.seat.reasoningEffort;
      // Checked against the route the model will actually take — the DeepSeek
      // route has `off` and no `medium`, the compatible route the reverse.
      if (effort !== undefined && !reasoningEffortsFor({ backend: "dsh", model: modelId }).includes(effort)) {
        return refusedRun(
          `⚠️ ${modelId === "" ? "DeepSeek 默认模型" : modelId} 走的这条线路没有「${effort}」这一档思考强度。`,
        );
      }

      // The patch is written per run, so the child starts after it is.
      return deferredRun("dsh", async () => {
        const heartbeat = ensureHeartbeatModule(join(options.stateDir, "dsh"));
        // The connection's model and endpoint: dsh has no environment variable
        // for either, so without this a MiniMax key goes to DeepSeek's
        // endpoint and comes back as an invalid key (2.x §12).
        const model = buildDshPatch({ model: modelId, baseUrl: (connection?.endpoint ?? "").trim(), effort });
        // ALWAYS written: the heartbeat must be mounted on every run, and the
        // delegation fence rides the same patch (off unless this seat was
        // created allowing subagents).
        const patch = [
          heartbeatRows(heartbeat).join("\n"),
          ...(model === undefined ? [] : [model]),
          ...(request.seat.subagents === true ? [] : [delegationOffRows().join("\n")]),
        ].join("\n");
        const patchDir = await mkdtemp(join(tmpdir(), "squad-dsh-"));
        const patchPath = join(patchDir, "seat.patch.yml");
        // 0600: the file names a variable rather than carrying the secret, but
        // it still describes where this seat sends its traffic.
        await writeFile(patchPath, `${patch}\n`, { mode: 0o600 });
        const env: Record<string, string | undefined> = { ...process.env, ...(request.connection?.env ?? {}) };
        // The compat route reads its key from its own variable; one credential
        // serves both routes whichever family the model belongs to.
        const key = request.connection?.env["DEEPSEEK_API_KEY"];
        if (key !== undefined) env[COMPAT_API_KEY_ENV] = key;
        return runCliSeat({
          who: "dsh",
          command,
          args: buildDshArgv({ prompt: "-", profile: PROFILE, patchPath }),
          stdin: request.prompt,
          cwd: request.cwd,
          env,
          // Removed after the run either way: a patch left behind describes
          // where a seat sent its traffic, in a shared temp directory.
          cleanup: async () => {
            await rm(patchDir, { recursive: true, force: true }).catch(() => undefined);
          },
          parse: (stdout, stderr) => readDshOutput(stdout, stderr),
          limits: SEAT_SILENCE_LIMITS,
          signal: request.signal,
          onActivity: request.onActivity,
        });
      });
    },
  };
}
