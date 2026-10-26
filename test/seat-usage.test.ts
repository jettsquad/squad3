// 移植自 Squad 2.x packages/shared/test/seat-usage.test.ts @ 8dcb903
// 改动：去掉 `usageOfResult` 那一组——它读的是 dsh 结果对象上的扩展字段，3 里不存在。
/**
 * Accounting has one job: be trustworthy when someone acts on it. Every test
 * here is about a way a total could quietly lie.
 */
import { describe, expect, it } from "vitest";
import { EMPTY_TOTALS, addUsage, type SeatUsage } from "../src/shared/seat-usage.ts";

const turn = (over: Partial<SeatUsage> = {}): SeatUsage => ({
  inputTokens: 2,
  outputTokens: 4,
  cacheReadTokens: 0,
  cacheCreationTokens: 83625,
  costUsd: 0.5,
  durationMs: 5888,
  ...over,
});

describe("addUsage", () => {
  it("adds each counter separately", () => {
    const total = addUsage(addUsage(EMPTY_TOTALS, turn()), turn());
    expect(total).toMatchObject({
      turns: 2,
      inputTokens: 4,
      outputTokens: 8,
      cacheCreationTokens: 167250,
      costUsd: 1,
    });
  });

  it("does not count a turn that reported nothing", () => {
    // Counting it would make the average cost per turn drop for a reason that
    // has nothing to do with cost.
    expect(addUsage(EMPTY_TOTALS, undefined)).toBe(EMPTY_TOTALS);
  });

  it("leaves cost absent until some turn reports one", () => {
    // A total of 0 claims the work was free. "Nobody told us" is a weaker and
    // truer statement, and the difference matters to anyone reading a bill.
    const total = addUsage(EMPTY_TOTALS, turn({ costUsd: undefined }));
    expect(total).not.toHaveProperty("costUsd");
    expect(total.turns).toBe(1);
  });

  it("keeps accumulating cost once one turn reports it", () => {
    const first = addUsage(EMPTY_TOTALS, turn({ costUsd: undefined }));
    const second = addUsage(first, turn({ costUsd: 0.25 }));
    expect(second.costUsd).toBe(0.25);
  });

  it("never folds cache tokens into input", () => {
    // The measurement this exists for: 2 input against 83,625 of cache
    // creation on a turn whose whole prompt was 「只回答 OK」.
    const total = addUsage(EMPTY_TOTALS, turn());
    expect(total.inputTokens).toBe(2);
    expect(total.cacheCreationTokens).toBe(83625);
  });
});
