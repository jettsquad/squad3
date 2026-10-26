// 移植自 Squad 2.x packages/reasoning/src/activation.ts @ 8dcb903
/**
 * activation.ts — when a proposal may skip the human, and when it may not.
 *
 * Only proposals that do not change what the library CLAIMS are ever
 * eligible. A reinforce adds evidence to wording the human already approved;
 * a new, a revise or a counter-example edits the standard itself, and that is
 * exactly the case where a system approving its own change is grading itself.
 * So the gate below is asked about reinforcements and nothing else.
 *
 * Three conditions, and the order they are checked in is the design:
 *
 *   COST FIRST. A criterion guarding an irreversible action keeps human
 *   confirmation permanently, however good its record. Being right a hundred
 *   times does not make the hundred-and-first mistake recoverable, and the
 *   whole point of a cost dimension is that it does not average out.
 *
 *   THEN CONFIDENCE, as a lower bound rather than a raw rate. Three-for-three
 *   is a rate of 1.0 and means almost nothing; twenty-eight-of-thirty means a
 *   great deal. A lower bound folds sample size in by construction, so no
 *   separate "at least N times" threshold has to be invented and tuned.
 *
 *   THEN FORCED EXPLORATION. Even a criterion with an excellent bound is
 *   asked about occasionally, because standards drift: last year's right
 *   answer may not be this year's, and a gate that never asks can never find
 *   that out. The cost of asking is one click; the cost of not asking is
 *   never learning that the library has gone stale.
 */

/** 95% one-sided-ish z. */
const Z = 1.96;

/** Lower bound of the agreement rate. Confidence, not popularity. */
export function wilsonLowerBound(accepted: number, total: number): number {
  if (total <= 0) return 0;
  const p = accepted / total;
  const z2 = Z * Z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = Z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  const bound = (centre - margin) / denominator;
  return bound < 0 ? 0 : bound;
}

/**
 * Agreement needed before a reinforcement may apply itself.
 *
 * Calibrated against the bound's actual behaviour rather than picked as a
 * round number — the design's own example says thirty-with-twenty-eight is
 * where a record becomes trustworthy, and that computes to 0.787:
 *
 *     3/3   → 0.438      10/10 → 0.722      28/30 → 0.787
 *     5/5   → 0.566      18/20 → 0.699      30/30 → 0.886
 *     9/10  → 0.596                         90/100 → 0.826
 *
 * At 0.75 the ones that should not qualify do not — three-for-three, and ten
 * unbroken agreements, are both still small — and the two the design calls
 * trustworthy do. Setting it at 0.8 (tried first) excluded 28/30, which is
 * the exact case the design uses to describe a record that has earned it.
 */
export const CONFIDENCE_THRESHOLD = 0.75;

/** How often a well-established criterion is still put to the human. */
export const EXPLORATION_RATE = 0.1;

export interface ActivationInput {
  readonly accepted: number;
  readonly rejected: number;
  /**
   * The criterion stands in front of something that cannot be undone.
   *
   * Read off the trigger rather than asked of a model: a feature flag is a
   * fact the agenda already carries, and a judgement call about how dangerous
   * something is would be exactly the wrong thing to automate here.
   */
  readonly guardsIrreversible: boolean;
  /** Injected so the exploration draw is testable; defaults to random. */
  readonly roll?: number | undefined;
}

export type ActivationReason = "guards-irreversible" | "no-record" | "below-confidence" | "forced-exploration" | "auto";

export interface ActivationDecision {
  readonly auto: boolean;
  readonly lowerBound: number;
  readonly reason: ActivationReason;
  readonly detail: string;
}

export function decideActivation(input: ActivationInput): ActivationDecision {
  const total = input.accepted + input.rejected;
  const lowerBound = wilsonLowerBound(input.accepted, total);

  if (input.guardsIrreversible) {
    return {
      auto: false,
      lowerBound,
      reason: "guards-irreversible",
      detail: "这条判据把守的是不可逆动作，长期保留人工确认——一百次对不会让第一百零一次的错可撤销。",
    };
  }
  if (total === 0) {
    return { auto: false, lowerBound, reason: "no-record", detail: "还没有任何裁定记录，先问人。" };
  }
  if (lowerBound < CONFIDENCE_THRESHOLD) {
    return {
      auto: false,
      lowerBound,
      reason: "below-confidence",
      detail: `同意率下界 ${lowerBound.toFixed(2)} 低于 ${CONFIDENCE_THRESHOLD}（${input.accepted}/${total}）。`,
    };
  }
  const roll = input.roll ?? Math.random();
  if (roll < EXPLORATION_RATE) {
    return {
      auto: false,
      lowerBound,
      reason: "forced-exploration",
      detail: "抽到了强制探索：即使记录很好也要偶尔问一次，因为标准会漂移。",
    };
  }
  return {
    auto: true,
    lowerBound,
    reason: "auto",
    detail: `同意率下界 ${lowerBound.toFixed(2)}，且不把守不可逆动作，自动生效。`,
  };
}
