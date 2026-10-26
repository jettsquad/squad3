// 移植自 Squad 2.x packages/shared/src/reasoning-effort.ts @ 8dcb903
/**
 * reasoning-effort.ts — how hard a seat's model thinks, across three backends.
 *
 * One vocabulary for the person, three spellings on the wire — each verified
 * by capturing the request a real CLI sends, not by reading docs:
 *
 * - Claude Code: `--effort X` → `output_config.effort`. The same field
 *   MiniMax's Anthropic-compatible endpoint reads, and the CLI sends it for a
 *   non-Claude model name too. Left unset, the CLI sends `high` on its own —
 *   so a MiniMax seat whose server default is `max` has been running at
 *   `high` all along.
 * - Codex: `-c model_reasoning_effort="X"`, passed through unchecked; which
 *   levels exist is per model, and Codex's own model cache says which.
 * - dsh: through the seat's profile patch. The DeepSeek route takes
 *   `off/low/high/max`; any other model rides the OpenAI-compatible route,
 *   which sends no reasoning field at all unless the patch declares levels.
 *
 * The level travels on the seam's own field, `agentOptions.reasoningEffort`,
 * and each backend translates it. Nothing here knows those spellings.
 */
import type { AgentBackend } from "./agent-template.ts";

/** Every level any backend offers, shallowest first. `off` disables thinking where that exists. */
export const REASONING_EFFORTS = ["off", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** The DeepSeek route of the dsh backend; every other model goes the OpenAI-compatible way. */
export function isDeepSeekModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("deepseek");
}

const CLAUDE_CODE: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
/**
 * What a Codex model offers when its own entry in Codex's cache is not there.
 * The floor every cached model shares — a level past it would fail at the
 * server, where the error names nothing a person chose.
 */
const CODEX_FALLBACK: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const DSH_DEEPSEEK: readonly ReasoningEffort[] = ["off", "low", "high", "max"];
const DSH_COMPATIBLE: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export interface EffortTarget {
  readonly backend: AgentBackend;
  /** The connection's model, when one is named. Absent means the host's own default. */
  readonly model?: string | undefined;
  /** For codex: the levels Codex's model cache lists for `model`, when it lists them. */
  readonly codexLevels?: readonly string[] | undefined;
}

/** The levels this backend and model actually accept. */
export function reasoningEffortsFor(target: EffortTarget): readonly ReasoningEffort[] {
  switch (target.backend) {
    case "claude-code":
      return CLAUDE_CODE;
    case "codex": {
      const known = (target.codexLevels ?? []).filter(isReasoningEffort);
      return known.length === 0 ? CODEX_FALLBACK : REASONING_EFFORTS.filter((level) => known.includes(level));
    }
    case "dsh":
      return target.model === undefined || target.model.trim() === "" || isDeepSeekModel(target.model)
        ? DSH_DEEPSEEK
        : DSH_COMPATIBLE;
  }
}

/**
 * Every level a backend could accept for SOME model — what a saved template
 * is checked against, since the template names a connection, not a model.
 */
export function reasoningEffortsOfBackend(backend: AgentBackend): readonly ReasoningEffort[] {
  switch (backend) {
    case "claude-code":
      return CLAUDE_CODE;
    case "codex":
      return REASONING_EFFORTS.filter((level) => level !== "off");
    case "dsh":
      return REASONING_EFFORTS.filter((level) => DSH_DEEPSEEK.includes(level) || DSH_COMPATIBLE.includes(level));
  }
}

/**
 * What happens when nobody chose — said out loud, because the obvious guess
 * is wrong: "default" is not "deepest", and for a MiniMax seat on Claude
 * Code it is not even the server's own default.
 *
 * - `sends`: the backend itself sends this level.
 * - `config`: whatever the host's own CLI configuration says.
 * - `none`: no field is sent; the server decides.
 */
export type DefaultEffort =
  { readonly kind: "sends"; readonly level: ReasoningEffort } | { readonly kind: "config" } | { readonly kind: "none" };

export function defaultEffortOf(target: EffortTarget): DefaultEffort {
  switch (target.backend) {
    case "claude-code":
      return { kind: "sends", level: "high" };
    case "codex":
      return { kind: "config" };
    case "dsh":
      return reasoningEffortsFor(target) === DSH_DEEPSEEK ? { kind: "sends", level: "high" } : { kind: "none" };
  }
}
