// 移植自 Squad 2.x packages/table/src/audit.ts @ 8dcb903
/**
 * audit.ts — what happened to this team, in order, on disk.
 *
 * 1.x kept an `audit.log` beside the transcript: state transitions,
 * confirmations, terminations. 2.0 had `logger.warn`, which is a stream that
 * scrolls past and is gone — so 「谁把这个议程确认了、什么时候、跑的是哪一
 * 份」 could only be answered by whoever happened to be watching.
 *
 * Deliberately NOT the transcript. The transcript is what the team said and
 * what the seats read; putting decisions in it would spend context on
 * bookkeeping and let a model's window fill with our own record-keeping. The
 * two answer different questions: the transcript answers "what was said", the
 * audit answers "what was decided, and to what".
 *
 * Bounded on purpose. An unbounded log inside team.json is a file
 * that grows until something else breaks, and the entries that matter are the
 * recent ones — a team's audit is read when something has just gone wrong.
 */

/** What kind of thing happened. Closed, so a reader can switch on it. */
export type AuditKind =
  | "team-created"
  /** Where a team came from: which plan, by its fingerprint. */
  | "team-origin"
  | "team-renamed"
  | "team-disbanded"
  | "seat-added"
  | "seat-removed"
  | "agenda-drafted"
  | "agenda-confirmed"
  | "agenda-resumed"
  | "agenda-paused"
  | "agenda-stopped"
  | "agenda-finished"
  | "agenda-discarded"
  | "agenda-rewound"
  | "agenda-abandoned"
  | "agenda-decided"
  | "material-added"
  | "material-removed"
  | "checkpoint-folded"
  | "checkpoint-revoked"
  | "seat-quiet"
  /** Brought over from Squad 2.x: where from, and what came. */
  | "imported";

/** One line of the audit. */
export interface AuditEntry {
  /** Unix epoch milliseconds. */
  readonly at: number;
  readonly kind: AuditKind;
  /** One sentence a person can read without opening anything else. */
  readonly detail: string;
  /**
   * The confirmation fingerprint, on the entries where one exists.
   *
   * Carried so 「跑的是不是我确认的那份」 can be answered from the audit
   * alone — that is the whole reason the hash is computed.
   */
  readonly agendaHash?: string | undefined;
}

/** How many entries one team keeps. */
export const AUDIT_LIMIT = 500;

/**
 * Append one entry, keeping the log bounded.
 *
 * The OLDEST are dropped: an audit is read after something went wrong, and
 * what went wrong is recent. Returned as a new array rather than mutated, so
 * a caller cannot half-apply it.
 */
export function appendAudit(log: readonly AuditEntry[], entry: AuditEntry): readonly AuditEntry[] {
  const next = [...log, entry];
  return next.length <= AUDIT_LIMIT ? next : next.slice(next.length - AUDIT_LIMIT);
}
