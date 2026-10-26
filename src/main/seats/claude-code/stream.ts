/**
 * stream.ts — reading a `stream-json` run back into one answer.
 *
 * 移植自 Squad 2.x packages/seat-claude-code/src/stream.ts @ 8dcb903
 * 改动：`SeatUsage` 的 import 路径。2026-10-20 用 claude 2.1.304 实测，信封字段与此一致。
 *
 * Carried from 1.x, which had this right: prefer the assistant text streamed
 * during the turn over the `result` envelope's own text, because a long turn's
 * envelope can summarise while the assistant blocks carry what was actually
 * said. Fall back to the envelope when nothing streamed, and fall back again
 * to plain text when there is no envelope at all — an older CLI, or a run
 * that failed before stream-json started.
 *
 * Every fallback is a real case seen in production, which is why they are
 * ordered rather than collapsed into "take whatever is there".
 */
import type { SeatUsage } from "../../../shared/seat-usage.ts";

export type { SeatUsage };

// The shape lives in @squad/shared: the provider measures it and the table
// records it, and those two may not import each other.
export interface StreamOutcome {
  readonly text: string;
  /** The CLI reported an error result, or the process failed. */
  readonly failed: boolean;
  /** Present when the envelope carried one. */
  readonly subtype?: string | undefined;
  /**
   * What the run consumed, when the envelope carried accounting.
   *
   * Absent rather than zeroed when unknown: a turn that reported nothing and a
   * turn that genuinely cost nothing are different facts, and a total built
   * from zeroes reads as "cheap" instead of "unmeasured".
   */
  readonly usage?: SeatUsage | undefined;
  /**
   * The CLI's own id for this conversation, when it said one.
   *
   * Kept so the NEXT turn can `--resume` it. That is the whole of the saving:
   * a resumed conversation re-reads its ~92k standing prefix from cache
   * instead of creating it again, measured at 65,897 → 62 tokens of cache
   * creation on this machine.
   *
   * Read from any event that carries it rather than only from the result
   * envelope: a run killed by the watchdog has an id worth keeping — the next
   * turn can still continue it — and it announced that id at startup.
   */
  readonly sessionId?: string | undefined;
}

interface StreamEvent {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly session_id?: unknown;
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly message?: { readonly content?: unknown } | undefined;
  readonly usage?: unknown;
  readonly total_cost_usd?: unknown;
  readonly duration_ms?: unknown;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Read the accounting off a result envelope.
 *
 * Field names verified against a live run rather than carried over from 1.x,
 * whose parser was written for an older CLI: the envelope now also holds
 * `modelUsage`, `iterations`, cache-creation breakdowns and timing that were
 * not there before. Only the four token counters plus cost and duration are
 * taken — the rest is real but not ours to interpret.
 */
function usageOf(envelope: StreamEvent): SeatUsage | undefined {
  const usage = envelope.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const record = usage as Record<string, unknown>;
  return {
    inputTokens: count(record["input_tokens"]),
    outputTokens: count(record["output_tokens"]),
    cacheReadTokens: count(record["cache_read_input_tokens"]),
    cacheCreationTokens: count(record["cache_creation_input_tokens"]),
    ...(typeof envelope.total_cost_usd === "number" ? { costUsd: envelope.total_cost_usd } : {}),
    ...(typeof envelope.duration_ms === "number" ? { durationMs: envelope.duration_ms } : {}),
  };
}

/**
 * The context the LAST model call of this run carried.
 *
 * Every assistant message reports its own call's usage; the envelope reports
 * the sum over all of them. The sum is what the turn cost, the last one is how
 * much the next call of this conversation will have to read — a turn of fifty
 * tool calls sums to millions while its context may be 300k.
 */
function lastContextTokens(events: readonly StreamEvent[]): number | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "assistant") continue;
    const usage = (event.message as { readonly usage?: unknown } | undefined)?.usage;
    if (typeof usage !== "object" || usage === null) continue;
    const record = usage as Record<string, unknown>;
    const total =
      count(record["input_tokens"]) +
      count(record["cache_read_input_tokens"]) +
      count(record["cache_creation_input_tokens"]);
    if (total > 0) return total;
  }
  return undefined;
}

const parseLines = (output: string): StreamEvent[] => {
  const events: StreamEvent[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed) as StreamEvent);
    } catch {
      // Not a stream line. An older CLI prints plain text, and the caller
      // falls back to it below rather than losing the answer.
    }
  }
  return events;
};

const textOfBlocks = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .map((text) => text.trim())
    .filter((text) => text !== "")
    .join("\n\n");
};

/** Read the finished run. `output` is everything the child wrote to stdout. */
export function readStream(output: string): StreamOutcome {
  const events = parseLines(output);
  const envelope = [...events].reverse().find((event) => event.type === "result");
  // The first one wins: the id is announced at startup and repeated, and a
  // later event carrying a different one would mean the CLI started a second
  // conversation — which is not something to record as this turn's.
  const sessionId = events.map((event) => event.session_id).find((id) => typeof id === "string" && id !== "") as
    string | undefined;
  const withSession = <T extends { readonly text: string; readonly failed: boolean }>(outcome: T): T =>
    (sessionId === undefined ? outcome : { ...outcome, sessionId }) as T;

  const streamed = events
    .filter((event) => event.type === "assistant")
    .map((event) => textOfBlocks(event.message?.content))
    .filter((text) => text !== "")
    .join("\n\n");

  if (envelope === undefined) {
    // Two different situations, and treating them as one dumped a whole
    // JSONL log into the discussion as if a seat had said it.
    //
    // Events but no envelope: the CLI WAS speaking stream-json and never
    // reached its result — killed by the watchdog, or dying mid-retry. The
    // answer is whatever assistant text arrived, and nothing if none did.
    // The raw log is not an answer; it is a transcript of the machinery.
    if (events.length > 0) return withSession({ text: streamed, failed: true });

    // No events at all: not a stream-json run — an older CLI, or a failure
    // before the format started. Whatever came out is all there is, and an
    // empty answer is a failure rather than a silent success.
    const plain = output.trim();
    return { text: plain, failed: plain === "" }; // no events, so no id was ever announced
  }

  const failed = envelope.is_error === true || envelope.subtype !== "success";
  const fromEnvelope = typeof envelope.result === "string" ? envelope.result.trim() : "";
  const totals = usageOf(envelope);
  const context = lastContextTokens(events);
  const usage = totals === undefined || context === undefined ? totals : { ...totals, contextTokens: context };
  return {
    // On a failed run the envelope's own `result` is the CLI's account of why
    // (`API Error: …`), and the assistant text before it is only what the seat
    // had said by then. Kept alongside, not instead of: dropping it left a
    // refusal by the service looking like a seat that stopped talking.
    text:
      failed && /API Error/i.test(fromEnvelope) && !streamed.includes(fromEnvelope)
        ? [streamed, fromEnvelope].filter((part) => part !== "").join("\n\n")
        : streamed !== ""
          ? streamed
          : fromEnvelope,
    failed,
    ...(typeof envelope.subtype === "string" ? { subtype: envelope.subtype } : {}),
    // Carried even on a failed run: a turn that burned tokens and then errored
    // still cost what it cost, and dropping it would make failures look free.
    ...(usage === undefined ? {} : { usage }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}
