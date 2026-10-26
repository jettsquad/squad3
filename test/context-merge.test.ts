// 移植自 Squad 2.x packages/context/test/merge.test.ts @ 8dcb903
/**
 * The team record lives in two places — speech in the session log, checkpoints
 * in a storage domain — because dsh's persistence read path refuses
 * out-of-repo event types. These tests hold the seam where the two are
 * rejoined, which is the only genuinely new logic in this plugin.
 */
import { describe, expect, it } from "vitest";
import { mergeCheckpoints, type MergeableCheckpoint, type TranscriptEntry } from "../src/main/context/merge.ts";
import { CHECKPOINT_KIND, CHECKPOINT_REVOKED_KIND, selectContextEvents } from "../src/main/context/window.ts";
import { renderTimeline, SPEECH_KIND } from "../src/main/context/timeline.ts";

const said = (turnId: string, text: string): TranscriptEntry => ({ kind: SPEECH_KIND, text, turnId });

const fold = (
  checkpointId: string,
  coversUpTo: string,
  text: string,
  extra: Partial<MergeableCheckpoint> = {},
): MergeableCheckpoint => ({ checkpointId, coversUpTo, text, createdAt: 1, ...extra });

describe("mergeCheckpoints", () => {
  it("splices a checkpoint after the entry it covers, not at the end", () => {
    // The secretary writes without stopping the team, so turns keep landing
    // while it works. Appending at the end would make the checkpoint appear to
    // cover turns it never saw, and the window would drop them.
    const merged = mergeCheckpoints(
      [said("t1", "一"), said("t2", "二"), said("t3", "三")],
      [fold("cp1", "t2", "要点")],
    );
    expect(merged.map((e) => e.kind)).toEqual([SPEECH_KIND, SPEECH_KIND, CHECKPOINT_KIND, SPEECH_KIND]);
  });

  it("carries a revoked checkpoint together with its revocation", () => {
    // Not filtered here: revocation semantics live in window.ts, which is
    // tested for them. Deciding it twice is how two answers start to disagree.
    const merged = mergeCheckpoints([said("t1", "一")], [fold("cp1", "t1", "要点", { revokedAt: 2 })]);
    expect(merged.map((e) => e.kind)).toEqual([SPEECH_KIND, CHECKPOINT_KIND, CHECKPOINT_REVOKED_KIND]);
  });

  it("orders several checkpoints by when they were written", () => {
    const merged = mergeCheckpoints(
      [said("t1", "一"), said("t2", "二")],
      [fold("late", "t2", "后", { createdAt: 20 }), fold("early", "t1", "先", { createdAt: 10 })],
    );
    expect(merged.filter((e) => e.kind === CHECKPOINT_KIND).map((e) => e.checkpointId)).toEqual(["early", "late"]);
  });

  it("leads the stream with a checkpoint whose coverage is not in the log", () => {
    // Never silently discarded. Dropping it would cut history at a boundary
    // the seats never see the replacement for — the exact 1.x failure.
    const merged = mergeCheckpoints([said("t9", "只剩这条")], [fold("cp1", "t-gone", "要点")]);
    expect(merged[0]?.kind).toBe(CHECKPOINT_KIND);
    expect(merged).toHaveLength(2);
  });

  it("returns the log untouched when nothing has been folded", () => {
    const transcript = [said("t1", "一"), said("t2", "二")];
    expect(mergeCheckpoints(transcript, []).map((e) => e.text)).toEqual(["一", "二"]);
  });
});

describe("merge → window → timeline", () => {
  it("cuts at the checkpoint and shows the checkpoint standing in for what was cut", () => {
    // The end-to-end shape of the whole plugin: the folded turns are gone, and
    // what replaced them actually reaches the seat. In 1.x both halves of this
    // failed at once — history cut, replacement dropped, no error.
    const lines = renderTimeline(
      selectContextEvents(
        mergeCheckpoints(
          [said("t1", "很早以前"), said("t2", "也很早"), said("t3", "最近")],
          [fold("cp1", "t2", "此前讨论的要点")],
        ),
      ),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("此前讨论的要点");
    expect(lines[1]).toBe("最近");
    expect(lines.join("\n")).not.toContain("很早以前");
  });

  it("falls back to the whole discussion once the checkpoint is revoked", () => {
    const lines = renderTimeline(
      selectContextEvents(
        mergeCheckpoints(
          [said("t1", "很早以前"), said("t2", "也很早"), said("t3", "最近")],
          [fold("cp1", "t2", "此前讨论的要点", { revokedAt: 5 })],
        ),
      ),
    );
    expect(lines).toEqual(["很早以前", "也很早", "最近"]);
  });
});
