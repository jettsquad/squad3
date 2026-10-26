// 移植自 Squad 2.x packages/seat-dsh/src/stream.ts @ 8dcb903
/**
 * stream.ts — reading a headless DSH run back into one answer.
 *
 * `dsh --profile headless` prints the final assistant message as PLAIN TEXT
 * and exits: no envelope, no JSONL, and — in its own chunk switch — an
 * explicit `case "usage": return;`. The harness measures every model call and
 * the headless app throws the number away.
 *
 * So the accounting comes back on STDERR, written by the plugin Squad already
 * injects into the child for heartbeats. Not stdout, because stdout is the
 * answer: a marked line there would have to be stripped out of a person's
 * reply, and a stripper that ever misses corrupts the one thing this backend
 * exists to produce.
 *
 * Absent is still reported as absent. A child running an older harness, or one
 * killed before its first model call, has no figure — and a zero would read as
 * 「这一轮不花钱」, which is the reading that hid this gap in the first place.
 */
import { stripReasoning } from "../../../shared/index.ts";
import { usageFromStderr, type SeatOutcome } from "../../seat-runtime/index.ts";

export function readDshOutput(raw: string, stderr = ""): SeatOutcome {
  // Reasoning is stripped for the same reason it is on the Claude backend:
  // a reply that is visibly the model thinking aloud reads as an answer to
  // everyone downstream, including the next round's carried discussion.
  const text = stripReasoning(raw).trim();
  const totals = usageFromStderr(stderr);
  return {
    text,
    // No answer is a failure. A seat that returns nothing reads as a member
    // with nothing to say, which is the one reading that hides a broken run.
    failed: text === "",
    // Carried even on a failed run: a turn that burned tokens and then errored
    // still cost what it cost.
    ...(totals === undefined
      ? {}
      : {
          usage: {
            inputTokens: totals["inputTokens"] ?? 0,
            outputTokens: totals["outputTokens"] ?? 0,
            cacheReadTokens: totals["cacheReadTokens"] ?? 0,
            cacheCreationTokens: totals["cacheCreationTokens"] ?? 0,
          },
        }),
  };
}
