// 移植自 Squad 2.x packages/reasoning/test/store.test.ts @ 8dcb903
/**
 * The library is a directory the user owns. These tests hold the two things
 * that make it worth owning: it round-trips through plain files, and the
 * abstract/instance split is a fact about the layout rather than a rule some
 * future export routine has to remember.
 */
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CRITERIA_DIR, INSTANCES_DIR, ReasoningStore } from "../src/main/reasoning/store.ts";
import type { Criterion } from "../src/main/reasoning/criterion.ts";

const criterion: Criterion = {
  id: "c-invisible",
  trigger: { action: ["design-mechanism"], features: ["automatic", "invisible-result"] },
  claim: "不可见的自动机制，其失败模式必然是静默的。",
  evidence: [],
  status: "active",
};

let root = "";
let store: ReasoningStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lilx-"));
  store = new ReasoningStore(root);
  await store.init();
});

describe("ReasoningStore", () => {
  it("round-trips a criterion through a file on disk", async () => {
    await store.putCriterion(criterion);
    expect(await store.criteria()).toEqual([criterion]);
  });

  it("writes something a person can read without this tool", async () => {
    // The point of the whole format. A record only readable through the tool
    // that wrote it fails the first requirement: surviving that tool.
    await store.putCriterion(criterion);
    const text = await readFile(join(root, CRITERIA_DIR, "c-invisible.md"), "utf8");
    expect(text).toContain("## 主张");
    expect(text).toContain("不可见的自动机制");
  });

  it("keeps instances in a different directory from abstracts", async () => {
    // The export boundary IS the layout: abstracts may be given away,
    // instances carry the user's own project detail and never leave. Nothing
    // needs a privacy flag, because nothing has to remember the rule.
    await store.putCriterion(criterion);
    await store.putInstance({
      id: "i-1",
      situation: { action: "design-mechanism", features: ["automatic"] },
      proposed: "自动折叠不提示",
      verdict: "要在系统通道告知",
      project: "Squad2",
      at: "2026-08-21T00:00:00.000Z",
    });
    expect(await readdir(join(root, CRITERIA_DIR))).toEqual(["c-invisible.md"]);
    expect(await readdir(join(root, INSTANCES_DIR))).toEqual(["i-1.md"]);
    // The project name — the part that must not be exported — is only ever
    // written on the instance side.
    expect(await readFile(join(root, CRITERIA_DIR, "c-invisible.md"), "utf8")).not.toContain("Squad2");
  });

  it("fails the whole read on a file it cannot parse, naming it", async () => {
    // Skipping it would leave the library quietly holding fewer criteria than
    // the directory does — and the one that vanished is the one nobody will
    // think to look for.
    await store.putCriterion(criterion);
    await writeFile(join(root, CRITERIA_DIR, "broken.md"), "这不是一份判据", "utf8");
    await expect(store.criteria()).rejects.toThrow(/broken\.md/);
  });

  it("reads an empty library as empty rather than failing", async () => {
    expect(await store.criteria()).toEqual([]);
    expect(await store.proposals()).toEqual([]);
  });

  it("moves a proposal out of the queue once it is dealt with", async () => {
    await store.putProposal(criterion);
    expect(await store.proposals()).toHaveLength(1);
    await store.dropProposal(criterion.id);
    expect(await store.proposals()).toEqual([]);
  });
});
