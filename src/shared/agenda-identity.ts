// 移植自 Squad 2.x packages/shared/src/agenda-identity.ts @ 8dcb903
/**
 * agenda-identity.ts — which agenda this is, and proving it later.
 *
 * Two problems, one file, because they are the same question asked at two
 * moments.
 *
 * BEFORE confirmation: is the plan I am confirming still the plan I was
 * shown? A draft lives in one slot; a second panel, a re-drafted agenda, or a
 * stale tab can replace it between the render and the click. 1.x answered
 * this with `teamAgendaId` + `revision` + `status` and refused anything that
 * did not line up. Without it the last writer wins and nobody is told.
 *
 * AFTER it: is the plan that RAN the plan I confirmed? 1.x hashed the
 * canonical draft into `teamConfirmationHash`. The hash is not a security
 * boundary — the host is the authority here and may edit freely — it is an
 * audit fact: months later the record can still answer "was this what you
 * approved" without anyone having to remember.
 *
 * Canonicalisation is the load-bearing part of both. Two objects that mean
 * the same agenda must produce the same bytes, or the hash records the shape
 * of a JSON serialiser rather than the content of a plan.
 */
import type { AgendaSpec } from "./agenda.ts";

/**
 * The agenda as stable bytes.
 *
 * Keys sorted, absent optionals omitted rather than serialised as `null`, and
 * arrays left in their own order — phase order and task order ARE the plan,
 * so sorting them would make two different plans hash alike.
 */
export function canonicalAgenda(agenda: AgendaSpec): string {
  return canonicalJson(agenda);
}

/**
 * The same treatment for anything else that gets fingerprinted.
 *
 * A team plan needs it for exactly the reason an agenda does — 「落地的是不是
 * 我确认的那一份」 is the same question asked about a roster instead of a
 * schedule — and a second copy of these rules would be a second set of
 * subtleties to get wrong.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is not "a field set to nothing", it is a field that is not
    // there. Serialising it would make `{a:1}` and `{a:1,b:undefined}` differ.
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
}

// The hash itself lives in `@squad/table` (`hash.ts`), not here: it needs
// `node:crypto`, and this package is bundled into the browser panel — one
// Node import in a shared barrel and the whole client build stops. What is
// shared is the CANONICAL FORM, which is the part both sides must agree on
// and the part worth testing; hashing bytes is the trivial half.

/** Short enough to read aloud, long enough to be worth comparing. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/** What a draft is, beyond its content. */
export interface DraftIdentity {
  /** Stable across edits and re-drafts of the same team's plan. */
  readonly agendaId: string;
  /** Bumped every time a new draft replaces the standing one. */
  readonly revision: number;
}

/** What the caller believed it was confirming. */
export interface ClaimedIdentity {
  readonly agendaId?: string | undefined;
  readonly revision?: number | undefined;
}

export interface IdentityVerdict {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * Whether the caller is confirming the draft that is actually standing.
 *
 * A caller that names NOTHING is accepted: the slash command and older
 * clients do not know about revisions, and refusing them would break a
 * surface to guard against a race they cannot cause. A caller that names a
 * DIFFERENT one is refused — that is the case worth catching, because it is
 * silent: the person is looking at one plan and about to run another.
 */
export function draftIdentityMatches(standing: DraftIdentity, claimed: ClaimedIdentity): IdentityVerdict {
  if (claimed.agendaId !== undefined && claimed.agendaId !== standing.agendaId) {
    return { ok: false, detail: "你确认的是另一份草案——这支团队现在拿着的不是它。刷新一下再看。" };
  }
  if (claimed.revision !== undefined && claimed.revision !== standing.revision) {
    return {
      ok: false,
      detail:
        `这份草案已经被改过了（你看到的是第 ${claimed.revision} 版，现在是第 ${standing.revision} 版）。` +
        `刷新一下，确认你真正想跑的那一份。`,
    };
  }
  return { ok: true };
}
