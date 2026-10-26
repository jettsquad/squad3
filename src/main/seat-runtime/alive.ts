// 移植自 Squad 2.x packages/seat-runtime/src/alive.ts @ 8dcb903
/**
 * alive.ts — the liveness channel, and keeping it out of the failure channel.
 *
 * The watchdog decides a seat is gone by watching its output stop. That works
 * for a CLI that writes as it goes and fails completely for one that does
 * not: `dsh --profile headless` awaits the whole turn and then writes the
 * answer in a single `stdout.write`, so its byte count is ZERO however well
 * it is going. Measured, not assumed — a probe plugin in a real child showed
 * `assistant/chunk` arriving every 1.6s inside a process whose stdout had not
 * moved at all.
 *
 * Rather than lengthen the deadline — which only makes a person wait longer
 * without telling them anything — that backend now SAYS it is alive: a plugin
 * in the child writes one marked line to stderr as the model produces tokens
 * and as tools run. The signal is real work, never a timer: a timer would
 * keep a wedged process alive forever, which is worse than the bug it fixed.
 *
 * Marked, because stderr is already the FAILURE channel. `readStderrTail`
 * shows its last few lines as the reason a seat failed, and unmarked
 * heartbeats would push the real error — 「MISSING_CREDENTIAL: …」 — out of
 * that window and, past the 256 KB collection cap, off the buffer entirely.
 * So every heartbeat carries this prefix and every reader drops it.
 */

/**
 * What a heartbeat line starts with.
 *
 * The child writes it from its own copy of this literal — importing this
 * package into a seat's child process would drag the whole subagent runtime
 * in with it — and a test asserts the two are the same string.
 */
export const SEAT_ALIVE_PREFIX = "[squad-alive]";

/**
 * What a usage line starts with.
 *
 * The second thing the child writes on this stream, and machinery in exactly
 * the same way: `dsh --profile headless` discards the harness's own usage
 * chunks (`case "usage": return;`), so a plugin in the child re-reports them
 * here. Like the heartbeat, it must never reach a person as the reason a seat
 * failed.
 */
export const SEAT_USAGE_PREFIX = "[squad-usage]";

/** Whether one line is a heartbeat rather than something a person should read. */
export const isAliveLine = (line: string): boolean => line.trimStart().startsWith(SEAT_ALIVE_PREFIX);

/** Whether one line is an accounting report rather than something to read. */
export const isUsageLine = (line: string): boolean => line.trimStart().startsWith(SEAT_USAGE_PREFIX);

/**
 * Strip heartbeats from collected stderr.
 *
 * Applied before anything measures or displays that text, so the liveness
 * channel is invisible to every reader except the byte counter that needs it.
 */
export function withoutHeartbeats(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isAliveLine(line) && !isUsageLine(line))
    .join("\n");
}

/**
 * The last accounting report a child wrote, if it wrote any.
 *
 * The LAST one, because each line carries the running total rather than one
 * call's share — see the child plugin. Taking the last means a truncated
 * stream still yields the complete figure, and a turn that died halfway still
 * reports what it had actually spent by then.
 */
export function usageFromStderr(text: string): Record<string, number> | undefined {
  const lines = text.split("\n").filter(isUsageLine);
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(last.trimStart().slice(SEAT_USAGE_PREFIX.length));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, number>;
  } catch {
    // A half-written line is what a killed process leaves behind. Losing the
    // accounting is the right cost; failing the turn over it is not.
    return undefined;
  }
}
