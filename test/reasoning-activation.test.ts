// 移植自 Squad 2.x packages/reasoning/test/activation.test.ts @ 8dcb903
/**
 * The gate that decides when the human may be skipped. Every branch here is
 * a case where getting it wrong is quiet: an over-eager gate edits the
 * library without anyone watching, and an over-cautious one turns every
 * confirmation into noise until they stop being read.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_THRESHOLD,
  EXPLORATION_RATE,
  decideActivation,
  wilsonLowerBound,
} from "../src/main/reasoning/activation.ts";

const solid = { accepted: 28, rejected: 2, guardsIrreversible: false, roll: 0.99 };

describe("wilsonLowerBound", () => {
  it("does not treat a perfect small sample as certainty", () => {
    // The whole reason for a bound instead of a rate: 3/3 is a rate of 1.0
    // and means almost nothing.
    expect(wilsonLowerBound(3, 3)).toBeLessThan(0.5);
  });

  it("rises with sample size at the same rate", () => {
    expect(wilsonLowerBound(28, 30)).toBeGreaterThan(wilsonLowerBound(3, 3));
  });

  it("puts the design's own example above the threshold and small perfect records below", () => {
    // The threshold was calibrated to these, not the other way round: 0.8 was
    // tried first and excluded 28/30, which is the exact case the design uses
    // to describe a record that has earned automatic effect.
    expect(wilsonLowerBound(28, 30)).toBeGreaterThan(CONFIDENCE_THRESHOLD);
    expect(wilsonLowerBound(10, 10)).toBeLessThan(CONFIDENCE_THRESHOLD);
    expect(wilsonLowerBound(3, 3)).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it("folds sample size in, so no separate minimum-N is needed", () => {
    // 9/10 and 90/100 are the same rate; only the second is trustworthy.
    expect(wilsonLowerBound(90, 100)).toBeGreaterThan(wilsonLowerBound(9, 10));
  });

  it("is zero with no record at all", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe("decideActivation", () => {
  it("auto-applies a well-established reinforcement", () => {
    const decision = decideActivation(solid);
    expect(decision.auto).toBe(true);
    expect(decision.lowerBound).toBeGreaterThan(CONFIDENCE_THRESHOLD);
  });

  it("never auto-applies a criterion guarding an irreversible action", () => {
    // Checked FIRST, and unconditionally. Being right a hundred times does
    // not make the hundred-and-first mistake recoverable, and a cost
    // dimension that averages out is not a cost dimension.
    const decision = decideActivation({ ...solid, accepted: 500, guardsIrreversible: true });
    expect(decision.auto).toBe(false);
    expect(decision.reason).toBe("guards-irreversible");
  });

  it("asks when there is no record yet", () => {
    expect(decideActivation({ accepted: 0, rejected: 0, guardsIrreversible: false, roll: 0.99 }).reason).toBe(
      "no-record",
    );
  });

  it("asks when a perfect record is still too small", () => {
    const decision = decideActivation({ accepted: 3, rejected: 0, guardsIrreversible: false, roll: 0.99 });
    expect(decision.auto).toBe(false);
    expect(decision.reason).toBe("below-confidence");
  });

  it("still asks sometimes even with an excellent record", () => {
    // Standards drift. A gate that never asks can never find that out, and
    // the cost of asking is one click against never learning the library has
    // gone stale.
    const decision = decideActivation({ ...solid, roll: EXPLORATION_RATE / 2 });
    expect(decision.auto).toBe(false);
    expect(decision.reason).toBe("forced-exploration");
  });

  it("explores at roughly the stated rate", () => {
    const asks = Array.from({ length: 1000 }, (_, index) => decideActivation({ ...solid, roll: index / 1000 })).filter(
      (decision) => decision.reason === "forced-exploration",
    ).length;
    expect(asks).toBe(EXPLORATION_RATE * 1000);
  });
});
