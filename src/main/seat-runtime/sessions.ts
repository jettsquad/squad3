// 移植自 Squad 2.x packages/seat-runtime/src/sessions.ts @ 8dcb903
/**
 * sessions.ts — which CLI conversation each seat is currently in.
 *
 * A side channel, and it exists because the seam has no room for this. A
 * provider's `start` receives a `SubagentStartRequest` whose fields are fixed
 * by dsh — label, prompt, parent, signal, tool filter, persona — and none of
 * them can carry "continue conversation X". Smuggling one through as an extra
 * property would depend on the request object surviving unchanged all the way
 * to the provider, which is not something the seam promises.
 *
 * So the table writes here and the backends read here, keyed by the two things
 * a provider CAN see: the parent session and the seat's label. That pair is
 * also exactly the isolation wanted — the same agent sitting in two teams, or
 * in two sittings of one team, is two conversations, and neither can be handed
 * the other's history.
 *
 * Module state and plain functions, following `activity.ts` next door: the
 * writer and the readers are in different packages that must not import each
 * other, and both already depend on this one.
 *
 * Persisted by the table (`snapshotSeatSessions` / `restoreSeatSessions`), so
 * a restart does not force every seat to open fresh. A stale id is recovered
 * the way it always was: `resumeWasRejected`, forget, retry fresh.
 *
 * Each entry also carries WHEN the conversation was last used and HOW BIG its
 * context had grown. Neither is needed to resume; both are needed to decide
 * whether resuming is worth it — see `@squad/table`'s `reopenReason`.
 */

/** One seat's conversation, and the two facts that decide whether to keep it. */
export interface SeatSession {
  readonly id: string;
  /** When its last turn ended, epoch ms. Absent for an entry saved before this was recorded. */
  readonly usedAt?: number | undefined;
  /** The context its last model call carried, in tokens. Absent when the backend did not say. */
  readonly contextTokens?: number | undefined;
}

const ids = new Map<string, SeatSession>();

const keyOf = (parentSessionId: string, label: string): string => `${parentSessionId} ${label}`;

/** The conversation this seat is already in, if any. */
export function seatSessionId(parentSessionId: string, label: string | undefined): string | undefined {
  if (label === undefined || label === "") return undefined;
  return ids.get(keyOf(parentSessionId, label))?.id;
}

/** The whole entry, facts included, if this seat has a conversation. */
export function seatSession(parentSessionId: string, label: string | undefined): SeatSession | undefined {
  if (label === undefined || label === "") return undefined;
  return ids.get(keyOf(parentSessionId, label));
}

export function rememberSeatSession(
  parentSessionId: string,
  label: string | undefined,
  id: string,
  facts: Omit<SeatSession, "id"> = {},
): void {
  if (label === undefined || label === "" || id === "") return;
  ids.set(keyOf(parentSessionId, label), {
    id,
    ...(facts.usedAt === undefined ? {} : { usedAt: facts.usedAt }),
    ...(facts.contextTokens === undefined ? {} : { contextTokens: facts.contextTokens }),
  });
}

/**
 * Drop one seat's conversation.
 *
 * Called when a resumed turn FAILED. An id the CLI no longer knows makes every
 * later turn fail the same way, and the error names a uuid the person has
 * never seen — so the recovery has to be automatic: forget it, and the next
 * turn opens a fresh conversation with the full window.
 */
export function forgetSeatSession(parentSessionId: string, label: string | undefined): void {
  if (label === undefined || label === "") return;
  ids.delete(keyOf(parentSessionId, label));
}

/**
 * Did this turn fail BECAUSE the conversation it was told to continue is gone?
 *
 * The test is that the failure names the id we passed. Every CLI phrases this
 * differently — `claude` says "No conversation found with session ID: <uuid>"
 * and exits 1 before it calls a model — but all of them have to say WHICH
 * conversation, and none of them mentions an id nobody supplied. So this
 * recognises the one failure a retry can actually cure, without a table of
 * per-CLI error strings that goes stale the next time one is reworded.
 *
 * Deliberately narrow. A seat that failed for any other reason must NOT be
 * run again: the commonest of those is a watchdog kill after a long silence,
 * and retrying that costs the silence a second time.
 */
export function resumeWasRejected(resumeSessionId: string | undefined, failureText: string): boolean {
  if (resumeSessionId === undefined || resumeSessionId === "") return false;
  return failureText.includes(resumeSessionId);
}

/**
 * Drop every seat's conversation under one parent.
 *
 * This is what a FOLD does. The secretary's checkpoint replaces the history
 * Squad hands out, but a CLI holding its own copy cannot be told to forget —
 * so the conversation itself is discarded and the next turn starts from the
 * checkpoint. It costs one un-resumed turn per seat, at the one moment where
 * the history was going to change out from under them anyway.
 */
export function forgetSeatSessions(parentSessionId: string): void {
  const prefix = `${parentSessionId} `;
  for (const key of [...ids.keys()]) {
    if (key.startsWith(prefix)) ids.delete(key);
  }
}

/** For tests, which must not inherit another case's conversations. */
export function resetSeatSessions(): void {
  ids.clear();
}

/**
 * Every seat's conversation id under one parent, for the table to persist.
 *
 * Read at the moment a turn ends (where the table already learns the id to
 * remember or forget) rather than kept as a running snapshot — this module's
 * map is the only source of truth, and reading it fresh avoids a second copy
 * that could drift from it.
 */
export function snapshotSeatSessions(parentSessionId: string): Record<string, SeatSession> {
  const prefix = `${parentSessionId} `;
  const out: Record<string, SeatSession> = {};
  for (const [key, session] of ids) {
    if (key.startsWith(prefix)) out[key.slice(prefix.length)] = session;
  }
  return out;
}

/**
 * Load a team's saved conversation ids back into this process, on restore.
 *
 * A restart previously meant every seat opened fresh — this module's map
 * starts empty and nothing rebuilt it. A ROW that turns out to name a
 * conversation the CLI already dropped is not a new failure mode: the same
 * rejection a stale in-memory id already produces, caught by
 * `resumeWasRejected` and retried fresh, exactly as it always was.
 *
 * A bare string is an entry saved before the facts were recorded. It is kept,
 * with no `usedAt` — which the reopen rule reads as "age unknown" and treats
 * as cold, because guessing warm is the expensive mistake.
 */
export function restoreSeatSessions(
  parentSessionId: string,
  sessions: Readonly<Record<string, string | SeatSession>>,
): void {
  for (const [label, saved] of Object.entries(sessions)) {
    if (typeof saved === "string") rememberSeatSession(parentSessionId, label, saved);
    else rememberSeatSession(parentSessionId, label, saved.id, saved);
  }
}
