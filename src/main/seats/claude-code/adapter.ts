/**
 * adapter.ts — the Claude Code seat.
 *
 * 移植自 Squad 2.x packages/seat-claude-code/src/index.ts @ 8dcb903
 * 改动：不再是 dsh 的 subagent provider，不再按「连接 × 权限模式 × …」注册一堆 provider 名——
 * 那是 dsh 的请求里装不下 per-request argv 时的绕法。3 的请求本身就带着席位的全部配置，
 * 连接也是开跑那一刻现查的。
 * 共享 skill 经 `--plugin-dir` 交付（skills-plugin.ts）；输出流跟踪（doing.ts）喂给看门狗与「正在做什么」。
 * 下载工具（联网时的 MCP）在阶段 5 回来。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CLAUDE_PERMISSION_MODES, DOWNLOAD_TOOL_NAME, WEB_TOOLS } from "../../../shared/agent-template.ts";
import { reasoningEffortsFor } from "../../../shared/reasoning-effort.ts";
import type { SeatAdapter, SeatRequest } from "../types.ts";
import type { SeatSpec } from "../../../shared/seat.ts";
import {
  DOWNLOAD_SERVER,
  downloadMcpConfig,
  deferredRun,
  refusedRun,
  runCliSeat,
  SEAT_SILENCE_LIMITS,
  type ResolvedCommand,
  type SeatRun,
} from "../../seat-runtime/index.ts";
import { DELEGATION_TOOLS, buildArgv, seatDenials } from "./argv.ts";
import { claudeConfigDirFor } from "./config-dir.ts";
import { claudeTracker } from "./doing.ts";
import { ensureSkillsPlugin } from "./skills-plugin.ts";
import { readStream } from "./stream.ts";

/**
 * What 「允许联网」 gives a Claude Code seat: the web tools and Squad's own
 * download tool pre-approved, and the download server mounted.
 *
 * Pre-approved because nobody is there to approve: a seat runs `claude -p`,
 * and a tool that asks for permission is refused. 2.x did this in the table
 * (`toolFilter`); the first 3 adapter dropped it, so a seat told in its
 * prompt that WebFetch was approved found it refused — configured, shown,
 * and not usable.
 */
export function webToolsFor(
  seat: Pick<SeatSpec, "webAccess">,
  cwd: string,
): {
  readonly toolFilter?: { readonly allow: readonly string[] };
  readonly mcpConfig?: string;
} {
  if (seat.webAccess !== true) return {};
  return {
    toolFilter: { allow: [...WEB_TOOLS, DOWNLOAD_TOOL_NAME] },
    mcpConfig: downloadMcpConfig(cwd, DOWNLOAD_SERVER),
  };
}

export function createClaudeCodeAdapter(resolve: (name: string) => ResolvedCommand, stateDir: string): SeatAdapter {
  return {
    backend: "claude-code",
    // `--append-system-prompt` and `--resume`: both real flags, both verified
    // in 2.x against the live CLI.
    capabilities: { persona: true, resume: true },
    locate: () => resolve("claude"),
    start(request: SeatRequest): SeatRun {
      let command: ResolvedCommand;
      try {
        command = resolve("claude");
      } catch (error) {
        return refusedRun(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
      }
      const { seat } = request;
      const hostCustomizations = seat.hostCustomizations === true;
      const mode = seat.permissionMode ?? "acceptEdits";
      // Refused rather than passed through: the CLI would reject it at startup
      // with a message about its own flag, not about the seat.
      if (!(CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) {
        return refusedRun(`⚠️ Claude Code 没有「${mode}」这种权限模式。`);
      }
      const effort = seat.reasoningEffort;
      if (effort !== undefined && !reasoningEffortsFor({ backend: "claude-code" }).includes(effort)) {
        return refusedRun(`⚠️ Claude Code 没有「${effort}」这一档思考强度。`);
      }
      return deferredRun("Claude Code", async () => {
        // An api-key seat runs against its own configuration home, stable per
        // connection: without one the host's login beats the connection's key;
        // with a fresh one per turn the CLI's record of the conversation is
        // deleted before the next turn can resume it (config-dir.ts).
        const configDir = claudeConfigDirFor({
          authMode: request.connection?.connection.authMode,
          connectionId: request.connection?.connection.connectionId,
          stateDir,
        });
        if (configDir !== undefined) await mkdir(configDir, { recursive: true });
        // The shared skills, as a folder this seat can be handed. A seat
        // reading the host's own configuration already has them.
        const skillsPluginDir = hostCustomizations
          ? undefined
          : await ensureSkillsPlugin(join(stateDir, "claude-skills-plugin"));
        return runCliSeat({
          who: "Claude Code",
          command,
          args: buildArgv({
            prompt: request.prompt,
            promptViaStdin: true,
            permissionMode: mode as (typeof CLAUDE_PERMISSION_MODES)[number],
            alwaysDeny: seatDenials(DELEGATION_TOOLS, seat.subagents === true),
            ...webToolsFor(seat, request.cwd),
            hostCustomizations,
            ...(effort === undefined ? {} : { effort }),
            ...(skillsPluginDir === undefined ? {} : { skillsPluginDir }),
            ...(request.persona === undefined ? {} : { persona: request.persona }),
            ...(request.resumeId === undefined ? {} : { resumeSessionId: request.resumeId }),
          }),
          stdin: request.prompt,
          cwd: request.cwd,
          env: {
            ...process.env,
            // The third part of the isolation `buildArgv` spells out: no flag
            // stops the CLI reading CLAUDE.md, only this does.
            ...(hostCustomizations ? {} : { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" }),
            // Endpoint, key and model, per the one injection rule
            // (`envForConnection`): nothing at all for a subscription seat.
            ...(request.connection?.env ?? {}),
            ...(configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }),
          },
          parse: (stdout) => readStream(stdout),
          tracker: claudeTracker,
          limits: SEAT_SILENCE_LIMITS,
          signal: request.signal,
          onActivity: request.onActivity,
        });
      });
    },
  };
}
