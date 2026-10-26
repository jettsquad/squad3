/**
 * seat-usage.ts — what one seat turn consumed, and how it rides home.
 *
 * 移植自 Squad 2.x packages/shared/src/seat-usage.ts @ 8dcb903
 * 改动：去掉 `SeatUsageCarrier` / `usageOfResult` / `sessionIdOfResult`。它们读的是挂在
 * dsh `SubagentResult` 上的扩展字段；3 的 `SeatResult` 直接带 `usage`，不需要绕。
 *
 * Here because it has two consumers: the seat adapter MEASURES it, the table
 * RECORDS it.
 *
 * Cache tokens stay separate from input, and that is not tidiness. Measured
 * in 2.x: a turn whose entire prompt was 「只回答 OK」 billed 2 input
 * tokens and 83,625 of cache creation — the host's own global CLAUDE.md,
 * which every CLI seat inherits. Summed into one "input" figure, a
 * three-orders-of-magnitude fact disappears into an average, and the thing a
 * person would actually want to act on is the part that vanished.
 */

export interface SeatUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  /** The backend's own accounting. Absent when it reported none. */
  readonly costUsd?: number | undefined;
  readonly durationMs?: number | undefined;
  /**
   * How big the context was on the turn's LAST model call, in tokens.
   *
   * Not a total, and deliberately not summed by `addUsage`: it answers "how
   * much does the next call of this conversation have to read", which is what
   * decides whether continuing it is still cheaper than starting over. The
   * four counters above are sums over every call in the turn and cannot say.
   */
  readonly contextTokens?: number | undefined;
}

/** Everything the counters can be added up over. */
export interface UsageTotals extends SeatUsage {
  /** Turns that reported accounting. Turns that reported none are not counted. */
  readonly turns: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Add one turn's usage to a running total.
 *
 * `costUsd` accumulates only from turns that reported one, and stays absent
 * while none has — a total of 0 would claim the work was free, which is a
 * stronger statement than "nobody told us".
 */
export function addUsage(total: UsageTotals, usage: SeatUsage | undefined): UsageTotals {
  if (usage === undefined) return total;
  const cost = usage.costUsd === undefined ? total.costUsd : (total.costUsd ?? 0) + usage.costUsd;
  const duration = usage.durationMs === undefined ? total.durationMs : (total.durationMs ?? 0) + usage.durationMs;
  return {
    turns: total.turns + 1,
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheCreationTokens: total.cacheCreationTokens + usage.cacheCreationTokens,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(duration === undefined ? {} : { durationMs: duration }),
  };
}
