// 移植自 Squad 2.x packages/shared/src/quotes.ts @ 8dcb903
/**
 * quotes.ts — resolving quoted line ids against the record.
 *
 * Here rather than in either plugin because both need it: the console
 * resolves quotes for a message the host sends now, and the table resolves
 * them for one that was queued and goes out later. Two copies of a rule about
 * what someone said is one copy too many.
 */

/** One line as the assembler sees it. */
export interface TranscriptLine {
  readonly kind: string;
  readonly text: string;
  readonly turnId: string;
}

/** A quoted line, split back into who said it and what they said. */
export interface Quote {
  readonly speaker: string;
  readonly text: string;
}

/**
 * Resolve quoted line ids against the record.
 *
 * From the RECORD, never from a request body: a quote is a claim about what
 * someone said, and one carried as text from a browser is only what that
 * browser last rendered.
 *
 * Unknown ids are dropped rather than refused — a line can be folded into a
 * checkpoint between the click and the send, and losing the emphasis is
 * better than losing the round.
 */
export function quotesFrom(events: readonly TranscriptLine[], ids: readonly string[]): readonly Quote[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  const quotes: Quote[] = [];
  for (const event of events) {
    if (event.kind !== "user/message" || !wanted.has(event.turnId)) continue;
    const match = /^【([^】]+)】([\s\S]*)$/.exec(event.text);
    quotes.push({ speaker: match?.[1] ?? "", text: (match?.[2] ?? event.text).trim() });
  }
  return quotes;
}
