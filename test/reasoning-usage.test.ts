// 移植自 Squad 2.x packages/reasoning/test/usage.test.ts @ 8dcb903
/**
 * The three scales are the library's only self-correction. Without them a set
 * of judgements slowly becomes a set of slogans that nobody can tell are
 * wrong — and the most dangerous one is the third, because its warning sign
 * looks like good news.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  REVIEW_AFTER_EVIDENCE,
  emptyUsage,
  healthOf,
  usageFromMarkdown,
  usageToMarkdown,
} from "../src/main/reasoning/usage.ts";
import { ReasoningStore } from "../src/main/reasoning/store.ts";

describe("healthOf", () => {
  const used = { ...emptyUsage("c1"), delivered: 3 };

  it("indicts the trigger when a criterion is never recalled", () => {
    // The claim is not unpopular; the filter never offered it to anyone.
    const health = healthOf(emptyUsage("c1"), 2);
    expect(health.verdict).toBe("never-delivered");
    expect(health.detail).toContain("触发条件写错了");
  });

  it("does not judge a never-delivered criterion on the other two scales", () => {
    // Reported as "never contradicted", it would read as a compliment for
    // having never been near a decision.
    expect(healthOf(emptyUsage("c1"), REVIEW_AFTER_EVIDENCE + 3).verdict).toBe("never-delivered");
  });

  it("flags plenty of evidence with no counter-example ever", () => {
    // The suspicious case, not the reassuring one: either too vague to
    // contradict, or nobody is testing it.
    const health = healthOf(used, REVIEW_AFTER_EVIDENCE);
    expect(health.verdict).toBe("never-contradicted");
    expect(health.detail).toContain("从未出现反例");
  });

  it("stays quiet while evidence is still thin", () => {
    expect(healthOf(used, REVIEW_AFTER_EVIDENCE - 1).verdict).toBe("ok");
  });

  it("says nothing about a criterion that has been contradicted", () => {
    expect(healthOf({ ...used, counterExamples: 1 }, REVIEW_AFTER_EVIDENCE + 5).verdict).toBe("ok");
  });

  it("flags one delivered often and marked useless, never useful", () => {
    const inert = { ...emptyUsage("c1"), delivered: REVIEW_AFTER_EVIDENCE, unhelpful: 3, counterExamples: 1 };
    expect(healthOf(inert, 1).verdict).toBe("delivered-but-inert");
  });

  it("does not call a criterion inert on silence alone", () => {
    // No mark either way is no evidence. Treating an unmarked delivery as a
    // failed one would invent the measurement the program cannot make.
    const unmarked = { ...emptyUsage("c1"), delivered: 20, counterExamples: 1 };
    expect(healthOf(unmarked, 1).verdict).toBe("ok");
  });
});

describe("usage round trip", () => {
  it("comes back unchanged", () => {
    const record = {
      criterionId: "c1",
      delivered: 4,
      counterExamples: 1,
      helpful: 2,
      unhelpful: 0,
      accepted: 3,
      rejected: 1,
      lastDeliveredAt: "2026-08-21T00:00:00.000Z",
    };
    expect(usageFromMarkdown(usageToMarkdown(record))).toEqual(record);
  });
});

describe("concurrent counting", () => {
  let store: ReasoningStore;

  beforeEach(async () => {
    store = new ReasoningStore(await mkdtemp(join(tmpdir(), "lilx-usage-")));
    await store.init();
  });

  it("loses no delivery when several land at once", async () => {
    // Read-modify-write without serialising drops increments, and an
    // undercount is invisible: it looks exactly like a criterion that was
    // recalled less often, which is the signal the first scale exists to give.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.updateUsage("c1", (current) => ({ ...current, delivered: current.delivered + 1 })),
      ),
    );
    expect((await store.usage("c1")).delivered).toBe(8);
  });

  it("reads a criterion with no usage yet as zeroed rather than missing", async () => {
    expect(await store.usage("never-used")).toEqual(emptyUsage("never-used"));
  });
});
