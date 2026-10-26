// 移植自 Squad 2.x packages/context/src/window.ts @ 8dcb903
/**
 * team-context-selection.ts — which recorded events a turn is shown.
 *
 * A turn carries the discussion so far, bounded by the newest context
 * checkpoint once one exists. The host can additionally quote specific
 * earlier replies, which reach back past the checkpoint.
 *
 * Quoting used to REPLACE the previous round — the composer even said so
 * ("本次不附带上一轮内容"). That made emphasis cost visibility: pointing at
 * an older reply silently removed the conversation the agent had just been
 * part of. A quote is emphasis, not a filter, so quoted replies are merged
 * into the round and marked, never substituted for it.
 */

/** The event shapes this module reads; anything else is passed through untouched. */
export interface SelectableEvent {
  readonly kind: string;
  readonly seatId?: unknown;
  readonly taskId?: unknown;
  readonly turnId?: unknown;
  readonly message?: unknown;
  readonly text?: unknown;
  readonly ts?: unknown;
  /** Checkpoint only: its own identity, so a later event can revoke it. */
  readonly checkpointId?: unknown;
  /** Checkpoint only: the last turn it actually summarised. See `carriedWindow`. */
  readonly coversUpTo?: unknown;
}

/** Marks a quoted reply in the assembled timeline so the agent sees the emphasis. */
export const QUOTED_PREFIX = "【主持人特别指出】";

/**
 * Identity of one recorded turn. Falls back to seat+task for transcripts
 * written before turn ids existed.
 *
 * The separator is NUL because it cannot occur in an id, so no seatId can be
 * chosen that makes two different pairs collide. It is written as the escape
 * `\u0000` and never as a raw byte: 1.x had the byte itself sitting in the
 * source, which made git treat the file as binary (no diffs, no review) and
 * left a character that any copy, editor or merge could drop in silence —
 * taking the collision guarantee with it and changing nothing visible.
 */
const identityOf = (event: SelectableEvent): string =>
  typeof event.turnId === "string" ? event.turnId : `${String(event.seatId)}\u0000${String(event.taskId)}`;

/** The event kind that marks a context checkpoint. */
export const CHECKPOINT_KIND = "contextCheckpoint";

/** The event kind that retires a checkpoint the host was not happy with. */
export const CHECKPOINT_REVOKED_KIND = "checkpointRevoked";

/**
 * The window a turn is shown.
 *
 * Without a checkpoint: everything. An agent is a fresh process every turn,
 * so it knows only what it is handed; carrying just the previous round left
 * it unable to remember a discussion it had itself taken part in. The upper
 * bound on this window is the checkpoint threshold, not a timid window.
 *
 * With a checkpoint: the newest live checkpoint, then every turn it did not
 * cover. Only the newest is used — a later checkpoint already inherits the
 * earlier one's settled items, so carrying both bills the same history twice
 * and lets the two disagree about what is still open.
 *
 * The cut is made at `coversUpTo`, NOT at the checkpoint's own position in
 * the log. The secretary writes a checkpoint without stopping the team, so
 * turns keep landing while it is being written and end up recorded BEFORE
 * it; those turns are not in it. Slicing at its position would drop them
 * with nothing standing in for them. `coversUpTo` names the last turn it
 * actually summarised, so everything younger travels whole.
 */
const carriedWindow = (priorRoundEvents: readonly SelectableEvent[]): readonly SelectableEvent[] => {
  const revoked = new Set(
    priorRoundEvents
      .filter((event) => event.kind === CHECKPOINT_REVOKED_KIND && typeof event.checkpointId === "string")
      .map((event) => event.checkpointId as string),
  );
  // A revoked checkpoint stops being context of any kind: it must neither
  // bound the window nor turn up inside it as if it were a contribution.
  const visible = priorRoundEvents.filter(
    (event) =>
      event.kind !== CHECKPOINT_REVOKED_KIND &&
      !(event.kind === CHECKPOINT_KIND && typeof event.checkpointId === "string" && revoked.has(event.checkpointId)),
  );

  let checkpointIndex = -1;
  for (let index = visible.length - 1; index >= 0; index--) {
    if (visible[index]?.kind === CHECKPOINT_KIND) {
      checkpointIndex = index;
      break;
    }
  }
  if (checkpointIndex < 0) return visible;

  const checkpoint = visible[checkpointIndex] as SelectableEvent;
  const coversUpTo = typeof checkpoint.coversUpTo === "string" ? checkpoint.coversUpTo : undefined;
  // A checkpoint written before `coversUpTo` existed falls back to its own
  // position: the old behaviour, which is correct whenever nothing ran
  // while it was being written.
  const boundary = coversUpTo === undefined ? checkpointIndex : visible.findIndex((e) => e.turnId === coversUpTo);
  const tail = visible
    .slice((boundary < 0 ? checkpointIndex : boundary) + 1)
    // The checkpoint itself leads the window; a superseded one must not
    // reappear behind it.
    .filter((event) => event.kind !== CHECKPOINT_KIND);
  return [checkpoint, ...tail];
};

/**
 * The tail of a window: only what this seat has not already been handed.
 *
 * The saving this exists for: a seat that continues its own CLI conversation
 * already HOLDS everything up to its last reply, and sending it again puts the
 * same text in the prompt twice — once in the conversation the CLI remembers,
 * once in the window Squad assembles. The duplication grows every round.
 *
 * Cut at the seat's own last SPEECH, found by the `【名字】` prefix the record
 * writes, because that is the last moment this seat is known to have seen
 * everything before it. Whatever came after — the other seats' replies, the
 * host's new question — is exactly what it has not been told.
 *
 * SAFE ONLY BECAUSE OF THE FOLD RULE. A checkpoint replaces history, and a
 * CLI holding its own copy cannot be told to forget; the table therefore
 * discards every seat's conversation when a fold happens, so a seat with a
 * live conversation is by construction a seat whose history has not been
 * rewritten since it last spoke. If that rule ever changes, this becomes
 * wrong — the seat would keep answering from the raw discussion a fold had
 * already compressed.
 *
 * Returns the WHOLE window when the seat has never spoken, which is the first
 * turn: there is no conversation to continue and nothing to trim against.
 */
export const tailForSeat = (events: readonly SelectableEvent[], displayName: string): readonly SelectableEvent[] => {
  // `text`, not `message`: the transcript stores 「【名字】说的话」 in `text`,
  // and `message` is the timeline layer's own field. Reading the wrong one
  // matches nothing, and a tail that matches nothing silently degrades into
  // sending the whole window — the exact duplication this removes.
  const spoke = (event: SelectableEvent): boolean =>
    typeof event.text === "string" && event.text.startsWith(`【${displayName}】`);
  let last = -1;
  for (const [index, event] of events.entries()) {
    if (spoke(event)) last = index;
  }
  return last < 0 ? events : events.slice(last + 1);
};

/**
 * The tail for a continuing seat, cut where it last LOOKED rather than where
 * it last spoke.
 *
 * Seats run in parallel now, so another seat can answer while this one is
 * still working. That answer lands before this seat's own reply, and
 * `tailForSeat` — which cuts at the last reply — would hand it over never.
 * Cutting at the last entry the seat's previous window was taken against
 * keeps it, and the seat's own lines after that point are dropped because
 * its conversation already holds them.
 *
 * Falls back to `tailForSeat` when the entry is no longer in the window (a
 * checkpoint moved past it) or was never known (the table restarted).
 */
export const tailSince = (
  events: readonly SelectableEvent[],
  seenUpTo: string,
  displayName: string,
): readonly SelectableEvent[] => {
  const at = events.findIndex((event) => event.turnId === seenUpTo);
  if (at < 0) return tailForSeat(events, displayName);
  return events
    .slice(at + 1)
    .filter((event) => !(typeof event.text === "string" && event.text.startsWith(`【${displayName}】`)));
};

/**
 * Assemble what this turn sees: the previous round, plus any quoted replies
 * the host chose, in transcript order, each appearing once.
 *
 * A quote that is already part of the previous round is not duplicated — it
 * is marked in place, so emphasis never costs a second copy of the text.
 */
export const selectContextEvents = (
  priorRoundEvents: readonly SelectableEvent[],
  quotedReplyEvents: readonly SelectableEvent[] = [],
): readonly SelectableEvent[] => {
  const round = carriedWindow(priorRoundEvents);
  const quotedIds = new Set(quotedReplyEvents.map(identityOf));
  const mark = (event: SelectableEvent): SelectableEvent =>
    quotedIds.has(identityOf(event)) && typeof event.message === "string"
      ? { ...event, message: `${QUOTED_PREFIX}${event.message}` }
      : event;

  const seen = new Set(round.map(identityOf));
  // Quotes from outside the round come first: they are older context the
  // host reached back for, and the round then reads in its own order.
  const older = quotedReplyEvents.filter((event) => !seen.has(identityOf(event))).map(mark);
  return [...older, ...round.map(mark)];
};
