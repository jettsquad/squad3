/**
 * adapter.ts — the Codex seat.
 *
 * 移植自 Squad 2.x packages/seat-codex/src/index.ts @ 8dcb903
 * 改动：同 claude-code——不再按连接 × 模式 × 联网 × 委派注册 provider，请求本身带着席位配置。
 * prompt 走标准输入：`codex exec … -` 与 `codex exec resume <id> … -` 都从 stdin 读
 * （codex-cli 0.163.0 的 --help，2026-10-20）。连接（端点、模型、CODEX_API_KEY）在开跑那一刻现查。
 *
 * No persona: `codex exec` takes one prompt and has no system-prompt
 * argument; declaring `persona: true` would be a lie the caller believes. The
 * seat's standing instructions already travel inside the prompt text.
 */
import { CODEX_PERMISSION_MODES } from "../../../shared/agent-template.ts";
import { modelArgumentFor } from "../../../shared/connection.ts";
import { reasoningEffortsFor } from "../../../shared/reasoning-effort.ts";
import {
  refusedRun,
  runCliSeat,
  SEAT_SILENCE_LIMITS,
  type ResolvedCommand,
  type SeatRun,
} from "../../seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest } from "../types.ts";
import { buildCodexArgv, isCodexMode } from "./argv.ts";
import { codexTracker } from "./doing.ts";
import { readCodexStream } from "./stream.ts";

/** The documented safe combination, and what a person means by "let it work". */
const DEFAULT_MODE = "workspace" as const;

export function createCodexAdapter(resolve: (name: string) => ResolvedCommand): SeatAdapter {
  return {
    backend: "codex",
    capabilities: { persona: false, resume: true },
    locate: () => resolve("codex"),
    start(request: SeatRequest): SeatRun {
      if (request.persona !== undefined) {
        // The caller is supposed to fold it into the prompt. Refused, not
        // dropped: a persona silently ignored is a seat answering without the
        // instructions it was chosen for.
        return refusedRun("⚠️ Codex 不支持单独的 persona；应当把它写进 prompt。");
      }
      let command: ResolvedCommand;
      try {
        command = resolve("codex");
      } catch (error) {
        return refusedRun(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
      }
      const mode = request.seat.permissionMode ?? DEFAULT_MODE;
      if (!isCodexMode(mode)) {
        return refusedRun(`⚠️ Codex 没有「${mode}」这种权限模式。可选：${CODEX_PERMISSION_MODES.join("、")}。`);
      }
      const effort = request.seat.reasoningEffort;
      if (effort !== undefined && !reasoningEffortsFor({ backend: "codex" }).includes(effort)) {
        return refusedRun(`⚠️ Codex 没有「${effort}」这一档思考强度。`);
      }
      const connection = request.connection?.connection;
      // The model rides on the command line for this backend — Codex has no
      // model environment variable — and only when it can be honoured.
      const model = connection === undefined ? undefined : modelArgumentFor(connection);
      const endpoint = (connection?.endpoint ?? "").trim();
      return runCliSeat({
        who: "Codex",
        command,
        args: buildCodexArgv({
          // `-`: read the prompt from stdin. Windows caps a command line at
          // 32,767 characters, and a prompt carries the discussion.
          prompt: "-",
          cwd: request.cwd,
          permissionMode: mode,
          webAccess: request.seat.webAccess === true,
          subagents: request.seat.subagents === true,
          ...(request.resumeId === undefined ? {} : { resumeSessionId: request.resumeId }),
          ...(model === undefined ? {} : { model }),
          // The endpoint as a one-off provider; 2.x found it stored, shown and
          // ignored before this was passed.
          ...(endpoint === "" ? {} : { endpoint }),
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        }),
        stdin: request.prompt,
        cwd: request.cwd,
        // `CODEX_API_KEY` for an api-key connection, nothing for a subscription.
        env: { ...process.env, ...(request.connection?.env ?? {}) },
        parse: (stdout) => readCodexStream(stdout),
        tracker: codexTracker,
        limits: SEAT_SILENCE_LIMITS,
        signal: request.signal,
        onActivity: request.onActivity,
      });
    },
  };
}
