/**
 * argv.ts — the command line, and the fence the stock provider cannot build.
 *
 * 移植自 Squad 2.x packages/seat-claude-code/src/argv.ts @ 8dcb903
 * 改动：加了 `promptViaStdin`。Windows 的命令行上限是 32,767 字符，带着整段讨论的
 * prompt 放不进 argv；为真时 `-p` 后面不跟 prompt，CLI 从标准输入读（2026-10-20 实测）。
 * 其余一字未改。
 *
 * The reason this package exists. `@deepseek-ai/dsh-subagent-claude-code`
 * hardcodes `disallowedTools: ['AskUserQuestion']` and exposes no way to add
 * to it: its config carries `env` and `disposeGraceMs` and nothing else. So a
 * secretary asked to draft an agenda can spawn its own subagents to do the
 * work instead — which is exactly what happened in 1.x, where a secretary
 * that did not know the roster invented a team of its own.
 *
 * 1.x's executor does not fix that either. It builds
 *
 *     claude -p <prompt> --output-format stream-json --verbose
 *            --include-partial-messages --permission-mode <mode>
 *
 * with no tool restriction at all — it is the cause, not the cure. What IS
 * worth carrying from it is everything else: stream-json for real activity,
 * partial messages so a long silence is distinguishable from a wedged
 * process, and the permission-mode mapping.
 *
 * Verified before building on it: `claude -p … --disallowed-tools Task`
 * answers "当前环境没有可供派生子 agent 执行一次性任务的 Task 工具，所以我
 * 直接用只读命令完成了这个任务". Structurally blocked, not asked nicely.
 */

/** Which tools a seat may see. Mirrors dsh's `ToolRestriction`. */
export interface ToolFence {
  /** Only these stay visible. */
  readonly allow?: readonly string[] | undefined;
  /** These are removed. */
  readonly deny?: readonly string[] | undefined;
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ArgvInput {
  readonly prompt: string;
  /** Leave the prompt out of argv; the caller writes it to stdin. */
  readonly promptViaStdin?: boolean | undefined;
  readonly toolFilter?: ToolFence | undefined;
  /** Appended to the CLI's own system prompt, not replacing it. */
  readonly persona?: string | undefined;
  readonly model?: string | undefined;
  readonly permissionMode?: PermissionMode | undefined;
  /**
   * Tools no seat may ever use, whatever the caller asked for.
   *
   * Delegation is the one that matters: a seat that spawns its own helpers
   * turns one accountable participant into an unlogged crowd, and nothing
   * downstream can tell the difference — the reply looks the same. This is a
   * floor rather than a default, so a caller cannot remove it by supplying
   * its own filter and forgetting.
   */
  readonly alwaysDeny?: readonly string[] | undefined;
  /**
   * Continue this conversation instead of starting one.
   *
   * The saving is the standing prefix. A fresh `claude -p` re-creates its
   * ~92k of system prompt, tool definitions and CLAUDE.md every time — 65,897
   * tokens of cache CREATION, measured, with only 26,552 served from cache.
   * Resumed, the same call creates 62 and reads 92,449.
   *
   * An id the CLI no longer knows makes the run fail, so the caller must be
   * able to drop it and start over rather than reporting a dead seat. See
   * the table's `resumeIdFor`.
   */
  readonly resumeSessionId?: string | undefined;
  /**
   * Let this seat read the HOST's customizations: `~/.claude/CLAUDE.md` and
   * everything it imports, plus the project's own `CLAUDE.md`, skills,
   * plugins, hooks and MCP servers.
   *
   * Off by default, and that is the change worth explaining. The CLI loads
   * all of it automatically, and on this machine that is 141,709 characters
   * of framework — measured: the standing prefix goes 38,070 → 100,113 with
   * it, so every cold start creates 62k extra tokens of cache, the dearest
   * tier there is. Roughly half of it describes capabilities a seat does not
   * have: slash commands it cannot call, `--think` flags it has no way to
   * set, wave orchestration and sub-agent delegation when `Task` is denied to
   * every seat by `DELEGATION_TOOLS`.
   *
   * What a seat SHOULD read instead is what the team gave it — its prompt
   * blocks — because that is per-seat, visible on screen, editable, and works
   * for the codex and dsh seats too, which can never see a `CLAUDE.md`.
   *
   * The project's own file is not lost with it: `--safe-mode` stops the CLI
   * from reading it and the TABLE reads it instead, so it still reaches the
   * seat, through a route Squad can show and control. See
   * `projectMemoryFor` in `@squad/table`.
   *
   * This stays reachable for the seat that is genuinely doing Claude Code's
   * own job in a repository and wants the whole configuration — but turning
   * it on buys the dead weight along with the useful part.
   */
  readonly hostCustomizations?: boolean | undefined;
  /**
   * `--effort`, when the agent chose one. Absent leaves the CLI to its own
   * default, which is `high` — sent even to a non-Claude model, measured.
   */
  readonly effort?: string | undefined;
  /** `--mcp-config` JSON, when the seat is given a tool of Squad's own. */
  readonly mcpConfig?: string | undefined;
  /**
   * `--plugin-dir`: the folder that carries the shared skills.
   *
   * See `skills-plugin.ts`. Ignored for a seat that reads the host's own
   * configuration — it already has whatever skills the host has.
   */
  readonly skillsPluginDir?: string | undefined;
}

/** Delegation tools, denied to every seat unless the composition says otherwise. */
export const DELEGATION_TOOLS: readonly string[] = ["Task", "Agent"];

/**
 * The floor of denied tools for one seat.
 *
 * The delegation tools come off it only for an agent created allowing
 * subagents; anything else the deployment denies stays denied regardless.
 */
export function seatDenials(alwaysDeny: readonly string[], subagents: boolean): readonly string[] {
  return subagents ? alwaysDeny.filter((tool) => !DELEGATION_TOOLS.includes(tool)) : alwaysDeny;
}

/**
 * Build the argv for one seat turn.
 *
 * `allow` and `deny` both travel when both are given. `--allowed-tools` is
 * PRE-APPROVAL, not an exclusive whitelist — measured, not assumed: a run with
 * `--allowed-tools WebFetch` still used `Read` normally. So naming a tool here
 * says "do not stop to ask about this one", and everything else keeps whatever
 * the permission mode gives it. A floor denial still holds on top.
 */
export function buildArgv(input: ArgvInput): readonly string[] {
  const argv = [
    "-p",
    ...(input.promptViaStdin === true ? [] : [input.prompt]),
    "--output-format",
    "stream-json",
    "--verbose",
    // Without partial messages the CLI emits nothing while the model thinks,
    // so a long reasoning block is indistinguishable from a wedged process and
    // an idle clock kills a seat that is working.
    "--include-partial-messages",
  ];

  // Unless the seat asked for the host's configuration, everything the CLI
  // would have loaded on its own is turned off here. Auth, model selection,
  // built-in tools and permissions are unaffected — that is what makes this
  // usable for a subscription seat, where giving the child its own
  // `CLAUDE_CONFIG_DIR` is not an option: measured, an isolated config home
  // answers "Not logged in · Please run /login", and copying `.claude.json`
  // into it does not help, because the CLI only reads the Keychain from the
  // default home.
  //
  // Spelled out, not `--safe-mode`. That flag was the first choice and it
  // does the same isolation in one word — but it also switches off the two
  // things a seat is deliberately GIVEN: `--mcp-config` (measured: the seat
  // answered that it had no such tool) and the skills of a `--plugin-dir`
  // (measured: the plugin loads, its skills do not appear). So the isolation
  // is written as its parts instead: no MCP servers but ours, no settings
  // files, and — set by the caller — no CLAUDE.md
  // (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`). With no settings sources the host's
  // own skills are not read either: measured, the catalogue is the CLI's
  // built-ins plus whatever the plugin folder carries, and nothing else.
  // Warm-cache cost measured equal to `--safe-mode`: ~2k created, ~40k read.
  if (input.hostCustomizations !== true) {
    argv.push("--strict-mcp-config", "--setting-sources", "");
    if (input.skillsPluginDir !== undefined && input.skillsPluginDir !== "") {
      argv.push("--plugin-dir", input.skillsPluginDir);
    }
  }

  // Before the permission flags, and before the prompt: the CLI reads it as a
  // top-level option, and everything after it still applies to the resumed
  // conversation.
  if (input.resumeSessionId !== undefined && input.resumeSessionId !== "") {
    argv.push("--resume", input.resumeSessionId);
  }

  const mode = input.permissionMode ?? "acceptEdits";
  if (mode === "bypassPermissions") argv.push("--dangerously-skip-permissions");
  else argv.push("--permission-mode", mode);

  if (input.model !== undefined && input.model !== "") argv.push("--model", input.model);
  if (input.effort !== undefined && input.effort !== "") argv.push("--effort", input.effort);
  if (input.persona !== undefined && input.persona.trim() !== "") {
    argv.push("--append-system-prompt", input.persona);
  }

  if (input.mcpConfig !== undefined) argv.push("--mcp-config", input.mcpConfig);

  const allow = input.toolFilter?.allow ?? [];
  if (allow.length > 0) argv.push("--allowed-tools", ...allow);

  const deny = [...new Set([...(input.alwaysDeny ?? DELEGATION_TOOLS), ...(input.toolFilter?.deny ?? [])])];
  if (deny.length > 0) argv.push("--disallowed-tools", ...deny);

  return argv;
}
