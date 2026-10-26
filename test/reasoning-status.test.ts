// 移植自 Squad 2.x packages/reasoning/test/status.test.ts @ 8dcb903
/**
 * 判据的状态迁移。
 *
 * 裁决原来是单向的：提议上点「采纳」「否掉」，已经生效的那些一个按钮都没有。
 * 采纳得太快的、措辞后来不合适的，只能去磁盘上找文件改。
 */
import { mkdtemp, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ReasoningStore, CRITERIA_DIR, PROPOSALS_DIR } from "../src/main/reasoning/store.ts";
import { criterionToMarkdown, type Criterion } from "../src/main/reasoning/criterion.ts";

const make = (id: string, status: Criterion["status"] = "active"): Criterion => ({
  id,
  trigger: { action: ["adjudicate"], features: [] },
  claim: "分歧不许压成共识",
  evidence: ["i-a"],
  status,
});

let root: string;
let store: ReasoningStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lil-x-status-"));
  store = new ReasoningStore(root);
  await store.init();
});

const put = async (criterion: Criterion): Promise<void> => {
  await mkdir(join(root, CRITERIA_DIR), { recursive: true });
  await writeFile(join(root, CRITERIA_DIR, `${criterion.id}.md`), criterionToMarkdown(criterion), "utf8");
};

describe("停用", () => {
  it("改状态，不删文件", async () => {
    // 主张、边界、证据都还要读得到——收回一个判断，和丢掉当初为什么相信它，
    // 是两件事。
    await put(make("c-1"));
    const criterion = (await store.criteria()).find((c) => c.id === "c-1");
    await store.putCriterion({ ...(criterion as Criterion), status: "retired" });

    const text = await readFile(join(root, CRITERIA_DIR, "c-1.md"), "utf8");
    expect(text).toContain("status: retired");
    expect(text).toContain("分歧不许压成共识");
  });
});

describe("退回待裁定", () => {
  it("文件从 criteria 挪到 proposals，只留一份", async () => {
    // 两处都在会让同一条判据既生效又待裁定，界面上出现两次。
    await put(make("c-2"));
    const criterion = (await store.criteria()).find((c) => c.id === "c-2");
    await store.putProposal(criterion as Criterion);
    await store.dropCriterion("c-2");

    expect(await readdir(join(root, CRITERIA_DIR))).not.toContain("c-2.md");
    expect(await readdir(join(root, PROPOSALS_DIR))).toContain("c-2.md");
    expect((await store.proposals()).map((c) => c.id)).toEqual(["c-2"]);
  });

  it("退回之后不再被当作生效判据", async () => {
    await put(make("c-3"));
    await store.putProposal(make("c-3"));
    await store.dropCriterion("c-3");
    expect(await store.criteria()).toEqual([]);
  });
});
