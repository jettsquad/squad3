// 移植自 Squad 2.x packages/table/test/roster.test.ts @ 8dcb903
/**
 * Roster rules. Each of these fails quietly when unenforced, which is why
 * they are checked rather than trusted.
 */
import { describe, expect, it } from "vitest";
import { checkRemoval, checkRoster, placeSeat, secretaryOf } from "../src/main/table/roster.ts";
import type { SeatSpec } from "../src/shared/seat.ts";

const seat = (over: Partial<SeatSpec> = {}): SeatSpec => ({
  seatId: "s1",
  displayName: "甲",
  role: "架构",
  systemPrompt: "x",
  backend: "claude-code",
  ...over,
});

describe("checkRoster", () => {
  it("accepts an ordinary roster", () => {
    expect(checkRoster([seat(), seat({ seatId: "s2", displayName: "乙" })])).toEqual([]);
  });

  it("refuses an empty team", () => {
    expect(checkRoster([])[0]?.detail).toMatch(/至少要有一个席位/);
  });

  it("refuses two seats sharing a display name", () => {
    // The record identifies a speaker by name, so two 甲 are one speaker to
    // every later reader — the assembler and the secretary included.
    expect(checkRoster([seat(), seat({ seatId: "s2" })])[0]?.detail).toMatch(/席位名重复/);
  });

  it("refuses two secretaries and names both", () => {
    // 1.x silently replaced the old one. Replacement without a word means a
    // team can lose its secretary as a side effect of editing an unrelated
    // seat, and the only evidence is judgement work going somewhere else.
    const problems = checkRoster([
      seat({ isSecretary: true }),
      seat({ seatId: "s2", displayName: "乙", isSecretary: true }),
    ]);
    expect(problems[0]?.detail).toContain("甲");
    expect(problems[0]?.detail).toContain("乙");
  });

  it("allows a team with no secretary", () => {
    // Optional: judgement work then names no seat, which is today's behaviour
    // and a legitimate choice, not an error.
    expect(checkRoster([seat()])).toEqual([]);
  });
});

describe("secretaryOf", () => {
  it("finds the designated seat", () => {
    expect(secretaryOf([seat(), seat({ seatId: "s2", displayName: "乙", isSecretary: true })])?.displayName).toBe("乙");
  });

  it("returns nobody when none is designated", () => {
    expect(secretaryOf([seat()])).toBeUndefined();
  });
});

describe("checkRemoval", () => {
  const roster = [seat(), seat({ seatId: "s2", displayName: "乙", isSecretary: true })];

  it("lets an ordinary seat leave", () => {
    expect(checkRemoval(roster, "s1")).toEqual([]);
  });

  it("refuses to empty the team", () => {
    expect(checkRemoval([seat()], "s1")[0]?.detail).toMatch(/最后一个席位/);
  });

  it("refuses an unknown seat", () => {
    expect(checkRemoval(roster, "ghost")[0]?.detail).toMatch(/没有席位/);
  });

  it("guards the secretary behind an explicit confirmation", () => {
    // Removable, but not by accident: judgement work would keep being
    // requested and start landing on a default nobody chose.
    expect(checkRemoval(roster, "s2")[0]?.detail).toMatch(/是这支团队的秘书/);
    expect(checkRemoval(roster, "s2", { allowSecretary: true })).toEqual([]);
  });
});

describe("placeSeat", () => {
  it("没给位置就放末尾", () => {
    expect(placeSeat(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("放回原来的位置", () => {
    // 这是改连接的路径：先删后加，位置不变。
    expect(placeSeat(["a", "c"], "b", 1)).toEqual(["a", "b", "c"]);
    expect(placeSeat(["b", "c"], "a", 0)).toEqual(["a", "b", "c"]);
  });

  it("越界的位置被夹到两端，而不是产生空洞", () => {
    expect(placeSeat(["a"], "x", 9)).toEqual(["a", "x"]);
    expect(placeSeat(["a"], "x", -3)).toEqual(["x", "a"]);
  });

  it("不改原数组", () => {
    const seats = ["a", "b"];
    placeSeat(seats, "c", 0);
    expect(seats).toEqual(["a", "b"]);
  });
});
