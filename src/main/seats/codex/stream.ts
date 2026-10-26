// 移植自 Squad 2.x packages/seat-codex/src/stream.ts @ 8dcb903
/**
 * stream.ts — reading `codex exec --json` back into one answer.
 *
 * The CLI emits JSONL: `thread.started`, `turn.started`, `item.completed`,
 * `turn.completed`, `turn.failed`, `error`. The agent's answer is the text of
 * the LAST `item.completed` whose item is an `agent_message`; accounting rides
 * on `turn.completed`.
 *
 * Last rather than concatenated, because a turn emits several agent messages
 * as it works and only the final one is the answer. Concatenating them
 * produces a reply that restates its own thinking — which is exactly the
 * failure `stripReasoning` exists to undo on the other backend.
 */
import type { SeatUsage } from "../../../shared/index.ts";

export interface CodexOutcome {
  readonly text: string;
  /** The CLI reported a failure, or nothing usable arrived. */
  readonly failed: boolean;
  /**
   * The reason, when the CLI gave one.
   *
   * Handed to `failureText`, which puts it ahead of the stderr tail: a
   * `turn.failed` message is the CLI's own account and beats whatever noise
   * it logged on the way there.
   */
  readonly detail?: string | undefined;
  /**
   * What the turn consumed, when `turn.completed` carried it.
   *
   * Absent rather than zeroed: a turn that reported nothing and a turn that
   * cost nothing are different facts.
   */
  readonly usage?: SeatUsage | undefined;
  /**
   * The CLI's own id for this conversation, announced on `thread.started`.
   *
   * Kept so the next turn can run `codex exec resume <id>` instead of opening
   * a fresh one. Measured on this machine: a resumed thread came back with
   * 15,744 of 15,896 input tokens served from cache, against a fresh thread
   * that cached 12,928 of 17,619 and paid for the rest again.
   */
  readonly sessionId?: string | undefined;
}

interface CodexEvent {
  readonly type?: unknown;
  readonly item?: { readonly type?: unknown; readonly text?: unknown } | undefined;
  readonly usage?:
    | {
        readonly input_tokens?: unknown;
        readonly cached_input_tokens?: unknown;
        readonly cache_write_input_tokens?: unknown;
        readonly output_tokens?: unknown;
      }
    | undefined;
  readonly message?: unknown;
  readonly error?: unknown;
  readonly thread_id?: unknown;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Parse the JSONL, skipping lines that are not JSON — stderr progress can interleave. */
function eventsOf(raw: string): readonly CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "" || !text.startsWith("{")) continue;
    try {
      events.push(JSON.parse(text) as CodexEvent);
    } catch {
      // A truncated final line is normal when a run is killed mid-write.
      // Skipping it loses nothing the earlier events did not already carry.
    }
  }
  return events;
}

export function readCodexStream(raw: string): CodexOutcome {
  const events = eventsOf(raw);

  let text = "";
  for (const event of events) {
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (item?.type !== "agent_message" || typeof item.text !== "string") continue;
    text = item.text;
  }

  let usage: SeatUsage | undefined;
  for (const event of events) {
    if (event.type !== "turn.completed" || event.usage === undefined) continue;
    const input = count(event.usage.input_tokens);
    const cached = count(event.usage.cached_input_tokens);
    const output = count(event.usage.output_tokens);
    if (input === undefined && cached === undefined && output === undefined) continue;
    usage = {
      // SUBTRACTED, because codex's `input_tokens` already contains the
      // cached part and Claude's does not. Left as reported, the same column
      // meant two different things and a mixed team's total was the sum of
      // two vocabularies.
      //
      // Settled by arithmetic on three real calls in one thread rather than
      // by reading a doc: taken as exclusive, a resumed turn's total prompt
      // came out SMALLER than the fresh turn it continued (22,922 against
      // 30,547), which cannot happen — a conversation only grows. Taken as
      // inclusive, the three totals sit at 17,619 / 15,882 / 15,896 and the
      // new-input share falls as the cache warms.
      inputTokens: Math.max(0, (input ?? 0) - (cached ?? 0)),
      outputTokens: output ?? 0,
      cacheReadTokens: cached ?? 0,
      // Reported by codex and previously dropped on the floor. Zero on most
      // turns, but writing a cache is the expensive kind, and a column that
      // is always zero hides exactly the turns worth looking at.
      cacheCreationTokens: count(event.usage.cache_write_input_tokens) ?? 0,
    };
  }

  const failure = events.find((event) => event.type === "turn.failed" || event.type === "error");
  const detail =
    failure === undefined
      ? undefined
      : typeof failure.message === "string"
        ? failure.message
        : typeof failure.error === "string"
          ? failure.error
          : "codex 报告了一个失败，但没有给出原因。";

  // `thread.started` is the first line of the stream and carries it. Taken
  // from any event that has one, so a run that failed later still hands back
  // an id the next turn can continue.
  const thread = events.map((event) => event.thread_id).find((id) => typeof id === "string" && id !== "");

  return {
    text,
    // No answer is a failure even without an error event: a seat that returns
    // nothing reads as a member with nothing to say, and that is the one
    // reading that hides a broken run.
    failed: failure !== undefined || text.trim() === "",
    ...(detail === undefined ? {} : { detail }),
    ...(usage === undefined ? {} : { usage }),
    ...(typeof thread === "string" ? { sessionId: thread } : {}),
  };
}
