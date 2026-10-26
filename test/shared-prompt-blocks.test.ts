// 移植自 Squad 2.x packages/shared/test/prompt-blocks.test.ts @ 8dcb903
/**
 * The middle tier decides what several seats have in common, so the ways it
 * can be wrong are all silent: a block that reaches nobody, one that reaches
 * everybody twice, one whose order flips the meaning of the two around it.
 */
import { describe, expect, it } from "vitest";
import {
  blocksForSeat,
  checkPromptSet,
  promptBlockSections,
  setsForSeat,
  type PromptSet,
  type TeamPrompts,
} from "../src/shared/prompt-blocks.ts";

const block = (id: string, text = `${id} 的正文`) => ({ blockId: id, name: id, text });

const prompts: TeamPrompts = {
  blocks: [block("章程"), block("工作方法"), block("交付自查"), block("数据口径")],
  teamBlockIds: ["章程"],
  sets: [
    { setId: "s1", name: "产出型席位", blockIds: ["工作方法", "交付自查"], seatIds: ["seat-1", "seat-2"] },
    { setId: "s2", name: "对外交付", blockIds: ["交付自查", "数据口径"], seatIds: ["seat-1", "seat-3"] },
  ],
};

describe("blocksForSeat", () => {
  it("团队的在前，集合的在后，集合之间按顺序", () => {
    // Order is the argument: the team's frame, then the group's method, then
    // (in the caller) the seat's own job. Read the other way round, a seat
    // takes the shared rules as commentary on its own.
    expect(blocksForSeat(prompts, "seat-1").map((b) => b.blockId)).toEqual([
      "章程",
      "工作方法",
      "交付自查",
      "数据口径",
    ]);
  });

  it("同一段被两个集合包含时只出现一次，位置按第一次", () => {
    // 「交付自查」 is in both sets and seat-1 is in both. Printed twice, a
    // model does not conclude it was configured twice — it concludes that
    // instruction outranks the ones around it.
    const ids = blocksForSeat(prompts, "seat-1").map((b) => b.blockId);
    expect(ids.filter((id) => id === "交付自查")).toHaveLength(1);
    expect(ids.indexOf("交付自查")).toBeLessThan(ids.indexOf("数据口径"));
  });

  it("不在任何集合里的席位只读团队那几段", () => {
    expect(blocksForSeat(prompts, "seat-9").map((b) => b.blockId)).toEqual(["章程"]);
  });

  it("点名了一段本队没有的片段，跳过而不是让这一轮失败", () => {
    // Runs on every turn of every seat. A block deleted from the library must
    // not be able to stop a round — its absence shows up in the composed
    // prompt, which is where someone looks when a seat's behaviour changed.
    const broken: TeamPrompts = { ...prompts, teamBlockIds: ["章程", "已经删掉的"] };
    expect(blocksForSeat(broken, "seat-1").map((b) => b.blockId)).toEqual(["章程", "工作方法", "交付自查", "数据口径"]);
  });

  it("正文是空白的片段不占位置", () => {
    // An empty section in every prompt of every round is a heading people
    // learn to skip — and then skip the one that had content.
    const blank: TeamPrompts = { ...prompts, blocks: [{ blockId: "章程", name: "章程", text: "   " }] };
    expect(blocksForSeat(blank, "seat-1")).toEqual([]);
  });
});

describe("setsForSeat", () => {
  it("答得出「这个席位为什么读到这段」", () => {
    expect(setsForSeat(prompts, "seat-3").map((s) => s.name)).toEqual(["对外交付"]);
  });
});

describe("promptBlockSections", () => {
  it("每段挂自己的名字，不合并成一个匿名段", () => {
    // The name is how a person reading the composed prompt tells which entry
    // a paragraph came from.
    const text = promptBlockSections(blocksForSeat(prompts, "seat-2")).join("\n");
    expect(text).toContain("## 工作方法");
    expect(text).toContain("## 交付自查");
    expect(text).not.toContain("## 数据口径");
  });
});

describe("checkPromptSet", () => {
  const known = { blockIds: ["章程"], seatIds: ["seat-1"] };
  const set: PromptSet = { setId: "s", name: "组", blockIds: ["章程"], seatIds: ["seat-1"] };

  it("接受一个完整的集合", () => {
    expect(checkPromptSet(set, known)).toEqual([]);
  });

  it("刚建出来的空集合只是提醒，不是错误", () => {
    // The state every set is in one second after 「新建集合」. Treated as an
    // error, the only route to a valid set ran through one the server would
    // not store — so the button did nothing at all.
    const fresh = { setId: "s", name: "集合 1", blockIds: [], seatIds: [] };
    const problems = checkPromptSet(fresh, known);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.severity === "warning")).toBe(true);
  });

  it("点名不存在的席位是错误，必须拒", () => {
    // This one really is corruption: an id that resolves to nothing would sit
    // in the record until some later round quietly skipped a seat.
    const problems = checkPromptSet({ ...set, seatIds: ["seat-9"] }, known);
    expect(problems[0]?.severity).toBe("error");
    expect(problems[0]?.detail).toContain("seat-9");
  });

  it("点名不存在的片段是错误", () => {
    expect(checkPromptSet({ ...set, blockIds: ["没有这段"] }, known)[0]?.severity).toBe("error");
  });
});
