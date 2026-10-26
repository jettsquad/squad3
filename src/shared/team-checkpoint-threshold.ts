// 移植自 Squad 2.x packages/shared/src/team-checkpoint-threshold.ts @ 8dcb903
/**
 * team-checkpoint-threshold.ts — when the discussion has grown enough to
 * need a checkpoint.
 *
 * Counting is the program's job; judgement is the secretary's. Asking a model
 * how big its own context has become is both expensive and unreliable, so the
 * reading here is arithmetic, and the secretary is only ever asked how the
 * content should be summarised.
 *
 * WHAT IS MEASURED: the discussion recorded since the last checkpoint — host
 * instructions plus replies, and nothing else. That is exactly the material a
 * turn carries today and exactly the material the next checkpoint will fold,
 * so it is the number a person can reason about: "how much has piled up since
 * we last summarised". It is identical across harnesses, because it is our own
 * transcript rather than whatever each CLI reports.
 *
 * It is NOT a running total of what turns consumed. Every turn resends the
 * whole window, so summing per-turn usage counts the same history once per
 * seat per round — a team would "cross" after ten short rounds while its
 * context had barely moved. `UsageLog` aggregates by summing, which makes that
 * the easy mistake to make; do not reuse it here.
 *
 * What backends report (`tokensIn`) is kept for DISPLAY only. It is the truest
 * measure of an actual prompt — it includes each agent's own system prompt and
 * tool definitions, which we cannot see — but it varies by harness and would
 * make the same setting behave differently per seat. One trigger, one number.
 */

/**
 * The context window this coefficient is a fraction of.
 *
 * Fixed rather than looked up per model: there is no API that reports a
 * model's window, a lookup table goes stale, and a team's seats can sit on
 * different models — so a per-model number would have to be entered again for
 * every model and re-entered whenever one is swapped. A fixed base with a
 * per-team coefficient asks the host for one number, once.
 */
export const CHECKPOINT_BASE_WINDOW_TOKENS = 1_000_000;

/**
 * Default fraction of the base a team accumulates before folding: ~100k
 * tokens, which is roughly 25 rounds for a four-seat team of ordinary
 * length — though the coefficient sets TOKENS, not rounds, so a team that
 * writes long proposals folds after far fewer.
 *
 * Why not higher: every turn resends the accumulation, so the recurring cost
 * scales with the threshold — caching divides that term by ten but leaves it
 * proportional to how long a team waits before folding. Modelled over 350
 * rounds, 0.7 bills about 4x what the cost-optimal interval does and 0.2
 * about 1.8x; 0.1 lands near 1.35x.
 *
 * Why not lower: the cost optimum sits near 3 rounds, and nobody wants the
 * last three rounds turned into an index. Each fold is also a rewrite — 已定
 * 事项 is inherited verbatim, but 未决分歧 is re-adjudicated every time, so
 * more folds mean more chances for wording to drift. 25 rounds is long enough
 * for a disagreement to actually develop and be worth re-judging.
 */
export const DEFAULT_CHECKPOINT_COEFFICIENT = 0.1;

/** Reasonable bounds for the host-set coefficient; outside these it stops meaning anything. */
export const MIN_CHECKPOINT_COEFFICIENT = 0.05;
export const MAX_CHECKPOINT_COEFFICIENT = 0.9;

export const thresholdTokensFor = (coefficient: number | undefined): number =>
  Math.round(CHECKPOINT_BASE_WINDOW_TOKENS * clampCheckpointCoefficient(coefficient));

export const clampCheckpointCoefficient = (coefficient: number | undefined): number => {
  if (typeof coefficient !== "number" || !Number.isFinite(coefficient)) return DEFAULT_CHECKPOINT_COEFFICIENT;
  return Math.min(MAX_CHECKPOINT_COEFFICIENT, Math.max(MIN_CHECKPOINT_COEFFICIENT, coefficient));
};

/**
 * CJK characters cost about one token each; Latin script about a quarter of
 * one. A single blended ratio underestimates Chinese by roughly half, and
 * underestimating means folding LATE — the failure that costs a blown context
 * rather than an early summary. Counting the two scripts apart keeps mixed
 * prose honest in both directions.
 *
 * This is still an estimate: every provider tokenises differently, and no
 * bundled tokenizer would be right for Claude, Codex and DeepSeek at once.
 * Anything shown to the host says 约.
 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
export const LATIN_CHARS_PER_TOKEN = 4;

export const estimateTokens = (text: string): number => {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / LATIN_CHARS_PER_TOKEN);
};

/** One piece of recorded discussion, as the counter sees it. */
export interface CountedContent {
  readonly text: string;
}

/** Total estimated tokens of everything recorded since the last checkpoint. */
export const accumulatedTokens = (contents: readonly CountedContent[]): number =>
  contents.reduce((total, item) => total + estimateTokens(item.text), 0);

export interface ThresholdDecision {
  readonly crossed: boolean;
  /** Estimated tokens accumulated since the last checkpoint. */
  readonly accumulated: number;
  /** The limit that number is being compared against. */
  readonly limit: number;
  /** Why nothing is being asked of the secretary right now. */
  readonly holdReason?: "below-threshold" | "already-running" | "team-busy" | undefined;
}

export interface ThresholdInput {
  /** Host messages and replies recorded since the last live checkpoint. */
  readonly contents: readonly CountedContent[];
  /** The team's coefficient; out-of-range or absent falls back to the default. */
  readonly coefficient?: number | undefined;
  /** A checkpoint is already being written; a second would cover the same ground. */
  readonly checkpointInFlight: boolean;
  /**
   * Someone is still working. Crossing only queues the request — the secretary
   * starts when the team is idle, so work never waits on it and the boundary
   * it records is taken with nothing in flight.
   */
  readonly teamBusy: boolean;
}

export const evaluateThreshold = (input: ThresholdInput): ThresholdDecision => {
  const accumulated = accumulatedTokens(input.contents);
  const limit = thresholdTokensFor(input.coefficient);
  if (accumulated < limit) return { crossed: false, accumulated, limit, holdReason: "below-threshold" };
  if (input.checkpointInFlight) return { crossed: false, accumulated, limit, holdReason: "already-running" };
  if (input.teamBusy) return { crossed: false, accumulated, limit, holdReason: "team-busy" };
  return { crossed: true, accumulated, limit };
};
