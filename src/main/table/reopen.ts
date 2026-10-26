// 移植自 Squad 2.x packages/table/src/reopen.ts @ 8dcb903
/**
 * reopen.ts — when continuing a seat's own conversation stops being worth it.
 *
 * Continuing is the cheap path only while two things hold, and both were
 * measured on a real seat before this existed:
 *
 * - The provider's prompt cache is still warm. It lasts an hour here — calls
 *   21 and 27 minutes apart were served from cache, calls 4 to 8 hours apart
 *   re-wrote the WHOLE context at the cache-write rate, which is dearer than
 *   plain input: 642k tokens re-written in one go after an overnight gap.
 * - The context is still small. Every model call re-reads all of it, and a
 *   seat doing firmware work makes a call per tool use — 476 calls in one
 *   conversation, the last ones reading ~800k each, 218M cache-read tokens in
 *   total, most of the conversation's cost.
 *
 * Past either line, a fresh conversation built from the newest checkpoint and
 * the discussion after it costs a fraction of one more resumed call.
 *
 * Arithmetic only. Nothing here asks a model anything.
 */
import type { SeatSession } from "../seat-runtime/index.ts";

/**
 * Idle time after which the cache is assumed gone. Under the hour it lasts,
 * so a turn starting just as it expires is not the one that finds out.
 */
export const REOPEN_AFTER_IDLE_MS = 50 * 60 * 1000;

/** Context past which a fresh start beats continuing, even with a warm cache. */
export const REOPEN_ABOVE_CONTEXT_TOKENS = 200_000;

/** Why a seat's conversation should be dropped before this turn, or nothing when it should continue. */
export type ReopenReason = "idle" | "age-unknown" | "oversized";

export function reopenReason(session: SeatSession | undefined, now: number): ReopenReason | undefined {
  if (session === undefined) return undefined;
  // An entry with no age came from before ages were recorded. Guessing warm
  // is the expensive mistake — a cold resume re-writes everything at the
  // dearest rate — so it is treated as cold.
  if (session.usedAt === undefined) return "age-unknown";
  if (now - session.usedAt >= REOPEN_AFTER_IDLE_MS) return "idle";
  if (session.contextTokens !== undefined && session.contextTokens >= REOPEN_ABOVE_CONTEXT_TOKENS) return "oversized";
  return undefined;
}
