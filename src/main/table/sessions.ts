/**
 * sessions.ts — several discussions for one team (2.x 「场次」, `table/sitting.ts`).
 *
 * A session is stored like a team (its own folder, log, usage, CLI
 * conversations, agenda and folds) plus `baseTeamId`, the team it belongs to.
 * What makes it the SAME team is held in common: the roster, the project
 * folder, the prompts, the material, the name and the fold threshold. The
 * table writes those to every session of the team whenever one changes, so no
 * session can drift into a different team.
 *
 * 2.x needed sittings because dsh opened many sessions per workspace; 3 first
 * dropped them as dsh plumbing (design doc, 「不再需要的 2.x 功能」), then brought them back as a
 * feature of their own (2026-10-22): a fresh discussion with the same people,
 * without re-building the team.
 */

/** The fields a team's sessions hold in common. */
export const SHARED_FIELDS = [
  "displayName",
  "projectFolder",
  "seats",
  "prompts",
  "materials",
  "checkpointCoefficient",
] as const;

export type SharedField = (typeof SHARED_FIELDS)[number];

/** What `sessions.ts` needs to know about a record. */
export interface SessionLike {
  readonly teamId: string;
  readonly createdAt: number;
  readonly baseTeamId?: string | undefined;
  readonly sessionName?: string | undefined;
}

/** The team a session belongs to: its base's id, or its own when it is the first session. */
export function groupIdOf(record: SessionLike): string {
  return record.baseTeamId ?? record.teamId;
}

/** The shared part of a record, as a patch. */
export function sharedOf<T extends Partial<Record<SharedField, unknown>>>(record: T): Pick<T, SharedField> {
  const shared: Partial<Record<SharedField, unknown>> = {};
  for (const field of SHARED_FIELDS) shared[field] = record[field];
  return shared as Pick<T, SharedField>;
}

/** Whether two records disagree on anything they should hold in common. Compared as JSON: the fields are plain data. */
export function sharedDiffers(
  a: Partial<Record<SharedField, unknown>>,
  b: Partial<Record<SharedField, unknown>>,
): boolean {
  // Same object first: sessions in memory share their common fields, so the
  // costly comparison (material can be hundreds of thousands of characters)
  // only runs when something was actually replaced.
  return SHARED_FIELDS.some((field) => a[field] !== b[field] && JSON.stringify(a[field]) !== JSON.stringify(b[field]));
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** 「10-22 19:40」 */
export function stampOf(at: number): string {
  const date = new Date(at);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * What a session is called in the list: its own name when given, otherwise
 * its place among the team's sessions and when it started.
 */
export function sessionLabel(record: SessionLike, siblings: readonly SessionLike[]): string {
  const name = (record.sessionName ?? "").trim();
  if (name !== "") return name;
  const ordered = [...siblings].sort((a, b) => a.createdAt - b.createdAt);
  const index = ordered.findIndex((one) => one.teamId === record.teamId);
  return `第 ${index < 0 ? 1 : index + 1} 场 · ${stampOf(record.createdAt)}`;
}

/**
 * The base of a 2.x sitting imported before 3 had sessions, read from the
 * import's own audit line (「从 Squad 2.x 导入（<base> 的一场 <id>）」). Those
 * were imported as teams of their own; this is what lets them rejoin the team
 * they came from. Undefined for anything else.
 */
export function legacySittingBase(record: {
  readonly baseTeamId?: string | undefined;
  readonly audit?: readonly { readonly kind: string; readonly detail: string }[] | undefined;
}): string | undefined {
  if (record.baseTeamId !== undefined) return undefined;
  for (const entry of record.audit ?? []) {
    if (entry.kind !== "imported") continue;
    const match = /^从 Squad 2\.x 导入（(\S+) 的一场 \S+）/.exec(entry.detail);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}
