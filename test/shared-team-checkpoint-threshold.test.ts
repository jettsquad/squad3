// 移植自 Squad 2.x packages/shared/test/team-checkpoint-threshold.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_BASE_WINDOW_TOKENS,
  DEFAULT_CHECKPOINT_COEFFICIENT,
  MAX_CHECKPOINT_COEFFICIENT,
  MIN_CHECKPOINT_COEFFICIENT,
  accumulatedTokens,
  clampCheckpointCoefficient,
  estimateTokens,
  evaluateThreshold,
  thresholdTokensFor,
} from "../src/shared/team-checkpoint-threshold.ts";

describe("estimateTokens", () => {
  // A single blended ratio underestimates Chinese by about half, and
  // underestimating means folding late — the failure that costs a blown
  // context rather than an early summary.
  it("counts CJK at about one token per character", () => {
    expect(estimateTokens("选型讨论")).toBe(4);
  });

  it("counts Latin script at about a quarter of a token per character", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
  });

  it("counts mixed prose by script rather than by one blended ratio", () => {
    // Four CJK + eight Latin: 4 + 2, not 12/2.
    expect(estimateTokens("选型讨论abcdefgh")).toBe(6);
  });

  it("returns zero for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("accumulatedTokens", () => {
  it("adds up everything recorded since the last checkpoint", () => {
    expect(accumulatedTokens([{ text: "选型讨论" }, { text: "abcdefgh" }])).toBe(6);
  });

  it("is zero right after a checkpoint, when nothing has been said yet", () => {
    expect(accumulatedTokens([])).toBe(0);
  });
});

describe("thresholdTokensFor", () => {
  it("is a fraction of the fixed base window", () => {
    expect(thresholdTokensFor(0.2)).toBe(CHECKPOINT_BASE_WINDOW_TOKENS * 0.2);
  });

  it("falls back to the default when the team has not set one", () => {
    expect(thresholdTokensFor(undefined)).toBe(CHECKPOINT_BASE_WINDOW_TOKENS * DEFAULT_CHECKPOINT_COEFFICIENT);
  });

  it("clamps values that would stop meaning anything", () => {
    expect(clampCheckpointCoefficient(0)).toBe(MIN_CHECKPOINT_COEFFICIENT);
    expect(clampCheckpointCoefficient(5)).toBe(MAX_CHECKPOINT_COEFFICIENT);
    expect(clampCheckpointCoefficient(Number.NaN)).toBe(DEFAULT_CHECKPOINT_COEFFICIENT);
  });
});

describe("evaluateThreshold", () => {
  const idle = { checkpointInFlight: false, teamBusy: false };
  const bulk = (tokens: number) => [{ text: "字".repeat(tokens) }];

  it("crosses once the accumulation reaches the limit", () => {
    const limit = thresholdTokensFor(0.05);
    expect(evaluateThreshold({ contents: bulk(limit), coefficient: 0.05, ...idle }).crossed).toBe(true);
  });

  it("holds below the limit and reports how far along it is", () => {
    const decision = evaluateThreshold({ contents: bulk(1_000), coefficient: 0.05, ...idle });
    expect(decision).toMatchObject({ crossed: false, accumulated: 1_000, holdReason: "below-threshold" });
    expect(decision.limit).toBe(50_000);
  });

  // Crossing queues the work; the secretary starts when nobody is working, so
  // the team never waits on it and the boundary is taken cleanly.
  it("queues rather than starting while the team is working", () => {
    const decision = evaluateThreshold({
      contents: bulk(60_000),
      coefficient: 0.05,
      checkpointInFlight: false,
      teamBusy: true,
    });
    expect(decision).toMatchObject({ crossed: false, holdReason: "team-busy" });
  });

  it("does not start a second checkpoint over the same ground", () => {
    const decision = evaluateThreshold({
      contents: bulk(60_000),
      coefficient: 0.05,
      checkpointInFlight: true,
      teamBusy: false,
    });
    expect(decision).toMatchObject({ crossed: false, holdReason: "already-running" });
  });

  // The trigger measures the discussion, not what turns consumed. Summing
  // per-turn usage would count the same history once per seat per round.
  it("counts each recorded contribution once, however many seats read it", () => {
    const decision = evaluateThreshold({ contents: [{ text: "字".repeat(100) }], coefficient: 0.2, ...idle });
    expect(decision.accumulated).toBe(100);
  });
});
