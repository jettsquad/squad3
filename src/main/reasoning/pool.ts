// 移植自 Squad 2.x packages/reasoning/src/pool.ts @ 8dcb903
/**
 * pool.ts — sharing abstracts, and the two things sharing must not become.
 *
 * NOT A SYNC, AND NOT A REPLACEMENT. An abstract arriving from the pool is a
 * CANDIDATE; whether it enters this library is decided by the owner's own
 * instances. So an import lands in `proposals/` — the same queue a locally
 * distilled proposal waits in — and is adopted one at a time or not at all.
 *
 * That routing is also the answer to averaging, which is the real risk here.
 * A pool whose default is everyone's consensus produces a mediocre middle,
 * and this framework's value is precisely that it takes positions —
 * evidence first, gates, independent answers are choices, not consensus.
 * Consensus files the edges off. Per-item opt-in keeps them, and it is
 * enforced by there being no code path from an import to an active criterion.
 *
 * What travels: trigger, claim, boundary, and aggregate support. What does
 * not: instances, project detail, transcripts, anybody's history. The export
 * boundary was already the directory split; this reuses it rather than
 * inventing a second rule that could disagree with the first.
 */
import type { Criterion } from "./criterion.ts";
import { checkAbstractness, type ContextMarker, type MarkerOptions } from "./decontextualise.ts";

/** One abstract as it travels. No identities, no instances. */
export interface PoolEntry {
  readonly trigger: Criterion["trigger"];
  readonly claim: string;
  readonly boundary?: string | undefined;
  /** How many people have supported it, and with how many occurrences between them. */
  readonly support: { readonly users: number; readonly instances: number };
}

export interface ExportRefusal {
  readonly criterionId: string;
  readonly markers: readonly ContextMarker[];
}

export interface ExportResult {
  readonly entries: readonly PoolEntry[];
  /**
   * Criteria held back because they are still tied to one place.
   *
   * Refused rather than scrubbed. Stripping the names would send a stranger
   * a sentence that no longer means anything — and it would pass the check
   * while being less useful than not sending it.
   */
  readonly refused: readonly ExportRefusal[];
}

/**
 * Prepare chosen criteria for the pool.
 *
 * Opt-in one at a time by construction: this takes the criteria the owner
 * picked, never "everything active". A function that exported the whole
 * library would make opting in the default, which is the same as not having
 * one.
 */
export function exportToPool(criteria: readonly Criterion[], options: MarkerOptions = {}): ExportResult {
  const entries: PoolEntry[] = [];
  const refused: ExportRefusal[] = [];
  for (const criterion of criteria) {
    const report = checkAbstractness(`${criterion.claim}\n${criterion.boundary ?? ""}`, options);
    if (!report.abstract) {
      refused.push({ criterionId: criterion.id, markers: report.markers });
      continue;
    }
    entries.push({
      trigger: criterion.trigger,
      claim: criterion.claim,
      ...(criterion.boundary === undefined ? {} : { boundary: criterion.boundary }),
      // One user — the owner — and however many occasions they have behind it.
      // Counts, never the instances themselves.
      support: { users: 1, instances: criterion.evidence.length },
    });
  }
  return { entries, refused };
}

/**
 * Turn arriving abstracts into local candidates.
 *
 * They come back with NO evidence, deliberately. Support in the pool is other
 * people's occasions; carrying it in as if it were this library's own would
 * let a criterion arrive already looking well-tested here, and the confidence
 * bound would then be computed from experiences its owner never had.
 */
export function importAsCandidates(entries: readonly PoolEntry[], idPrefix = "pool"): readonly Criterion[] {
  return entries.map((entry, index) => ({
    id: `${idPrefix}-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
    trigger: entry.trigger,
    claim: entry.claim,
    ...(entry.boundary === undefined ? {} : { boundary: entry.boundary }),
    evidence: [],
    status: "active" as const,
  }));
}

/** Merge one person's export into a pool listing, keeping only counts. */
export function mergeIntoPool(pool: readonly PoolEntry[], incoming: readonly PoolEntry[]): readonly PoolEntry[] {
  const merged = [...pool];
  for (const entry of incoming) {
    const existing = merged.findIndex((candidate) => candidate.claim === entry.claim);
    if (existing < 0) {
      merged.push(entry);
      continue;
    }
    const previous = merged[existing] as PoolEntry;
    // Support accumulates; the wording does NOT get averaged toward whatever
    // most people wrote. Rewriting a claim to the middle is exactly how a
    // pool of positions becomes a pool of platitudes.
    merged[existing] = {
      ...previous,
      support: {
        users: previous.support.users + entry.support.users,
        instances: previous.support.instances + entry.support.instances,
      },
    };
  }
  return merged;
}
