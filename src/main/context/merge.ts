// 移植自 Squad 2.x packages/context/src/merge.ts @ 8dcb903
/**
 * merge.ts — rejoining a team record that lives in two places.
 *
 * Speech is in the host session log; checkpoints are in the `squad_teams`
 * storage domain, because dsh's persistence read path refuses out-of-repo
 * event types (see domain.ts). Splitting the record was the price of not
 * losing it, and this is where the price is paid back.
 *
 * Kept pure and kept alone: it is the only place that knows the record has
 * two homes, so if dsh ever opens the event registration surface this one
 * function is what changes. It is also the only genuinely new logic in this
 * plugin — the two assembly layers were proven in 1.x — which is why it is
 * testable without a running harness.
 */
import { CHECKPOINT_KIND, CHECKPOINT_REVOKED_KIND, type SelectableEvent } from "./window.ts";

/** One recorded entry of the team log, flattened by the table. */
export interface TranscriptEntry {
  readonly kind: string;
  readonly text: string;
  readonly turnId: string;
}

/** A stored checkpoint, as much of it as merging needs. */
export interface MergeableCheckpoint {
  readonly checkpointId: string;
  readonly text: string;
  /** Identity of the last recorded entry this checkpoint summarises. */
  readonly coversUpTo: string;
  readonly createdAt: number;
  readonly revokedAt?: number | undefined;
}

/**
 * Splice each checkpoint into the log directly after the entry it covers.
 *
 * Placed at `coversUpTo`, not appended at the end, because that is where the
 * window layer cuts. The secretary writes without stopping the team, so turns
 * keep landing while it works; a checkpoint appended at the end would appear
 * to cover turns it never saw, and the window would drop them with nothing
 * standing in for them.
 *
 * A revoked checkpoint travels WITH its revocation marker rather than being
 * dropped here. Revocation semantics live in `window.ts`, which is tested for
 * them; a second place deciding the same thing is how two answers start to
 * disagree — and the one that would win here is the untested one.
 *
 * A checkpoint whose `coversUpTo` names no entry in the log is NOT silently
 * discarded: it leads the stream. Dropping it would cut history at a boundary
 * the seats never see the replacement for, which is the exact 1.x failure this
 * plugin exists to prevent. Leading the stream is the conservative reading —
 * it covers everything the log still holds.
 */
export function mergeCheckpoints(
  transcript: readonly TranscriptEntry[],
  checkpoints: readonly MergeableCheckpoint[],
): readonly SelectableEvent[] {
  const ordered = [...checkpoints].sort((a, b) => a.createdAt - b.createdAt);
  const known = new Set(transcript.map((entry) => entry.turnId));

  const byCoverage = new Map<string, MergeableCheckpoint[]>();
  const orphans: MergeableCheckpoint[] = [];
  for (const checkpoint of ordered) {
    if (!known.has(checkpoint.coversUpTo)) {
      orphans.push(checkpoint);
      continue;
    }
    const bucket = byCoverage.get(checkpoint.coversUpTo);
    if (bucket === undefined) byCoverage.set(checkpoint.coversUpTo, [checkpoint]);
    else bucket.push(checkpoint);
  }

  const stream: SelectableEvent[] = [];
  for (const checkpoint of orphans) emit(stream, checkpoint);
  for (const entry of transcript) {
    stream.push({ kind: entry.kind, text: entry.text, turnId: entry.turnId });
    for (const checkpoint of byCoverage.get(entry.turnId) ?? []) emit(stream, checkpoint);
  }
  return stream;
}

function emit(stream: SelectableEvent[], checkpoint: MergeableCheckpoint): void {
  stream.push({
    kind: CHECKPOINT_KIND,
    text: checkpoint.text,
    checkpointId: checkpoint.checkpointId,
    coversUpTo: checkpoint.coversUpTo,
    turnId: checkpoint.checkpointId,
  });
  if (checkpoint.revokedAt !== undefined) {
    stream.push({ kind: CHECKPOINT_REVOKED_KIND, checkpointId: checkpoint.checkpointId });
  }
}
