// 移植自 Squad 2.x packages/shared/src/capture-window.ts @ 8dcb903
/**
 * capture-window.ts — which lines a marked utterance is judged against.
 *
 * `capture` wants a PAIR: what the machine proposed, and what the human made
 * of it. A button on one message supplies only the second half, and the first
 * half is what decides whether a criterion comes out as a standard or as a
 * free-floating opinion — so the window that supplies it is the whole design
 * here, not plumbing.
 *
 * The rule is the host's, and it is sharper than "the message and some
 * context":
 *
 *   - Normally, everything the seats said between the host's PREVIOUS message
 *     and this one. That is exactly the material this utterance is a verdict
 *     on; anything earlier belongs to a decision already made.
 *   - When the utterance names seats with `@`, only those seats' replies in
 *     that window. Pointing at someone is saying which reply this answers,
 *     and it is the one case where the pairing is stated rather than inferred.
 *   - When no seat spoke in between, the pair has no first half, and that is
 *     kept rather than refused: a person who says two things in a row may be
 *     laying down a standard outright rather than overruling anyone.
 */

/** One line of the record, as the transcript stores it. */
export interface SpokenLine {
  readonly speaker: string;
  readonly text: string;
  readonly turnId: string;
}

export interface CaptureWindow {
  /** What the machine proposed. Empty when nobody spoke in between. */
  readonly proposed: string;
  /** What the human made of it — the marked utterance. */
  readonly verdict: string;
  /** Which seats' replies were taken, for a notice that says what was read. */
  readonly from: readonly string[];
}

/**
 * Build the window for one marked utterance.
 *
 * @param mentioned Seat names the utterance named with `@`, already parsed —
 *   parsing lives in the console with the rest of the mention grammar, and
 *   duplicating it here would be a second grammar to keep in step.
 * @returns `undefined` when the turn is not the host's own. The button is only
 *   offered on the host's messages, so this is a wrong call rather than a
 *   condition to render.
 */
export function captureWindow(
  transcript: readonly SpokenLine[],
  hostDisplayName: string,
  turnId: string,
  mentioned: readonly string[] = [],
): CaptureWindow | undefined {
  const index = transcript.findIndex((line) => line.turnId === turnId);
  if (index < 0) return undefined;
  const marked = transcript[index];
  if (marked === undefined || marked.speaker !== hostDisplayName) return undefined;

  // Back to the host's previous message, exclusive. Not a fixed number of
  // lines: a round with five seats and a round with one are the same shape of
  // occurrence, and a fixed window would cut one and pad the other.
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (transcript[i]?.speaker === hostDisplayName) {
      start = i + 1;
      break;
    }
  }

  const between = transcript.slice(start, index).filter((line) => line.speaker !== hostDisplayName);
  const named = new Set(mentioned);
  // Only when the named seats actually said something in this window. A name
  // that matches nothing would otherwise narrow the window to empty and throw
  // away the replies that ARE there.
  const picked =
    named.size > 0 && between.some((line) => named.has(line.speaker))
      ? between.filter((line) => named.has(line.speaker))
      : between;

  return {
    proposed: picked.map((line) => `【${line.speaker}】${line.text}`).join("\n\n"),
    verdict: marked.text,
    from: [...new Set(picked.map((line) => line.speaker))],
  };
}
