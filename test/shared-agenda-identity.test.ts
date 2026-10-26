// 移植自 Squad 2.x packages/shared/test/agenda-identity.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { canonicalAgenda, draftIdentityMatches, shortHash } from "../src/shared/agenda-identity.ts";
import type { AgendaSpec } from "../src/shared/agenda.ts";

const plan: AgendaSpec = {
  phases: [
    { title: "一", contextMode: "cumulative", tasks: [{ seatId: "s1", instruction: "甲" }] },
    { title: "二", contextMode: "independent", tasks: [{ seatId: "s2", instruction: "乙" }] },
  ],
};

describe("规范化", () => {
  it("字段顺序不影响结果", () => {
    // 不然哈希记的是某个 JSON 序列化器的心情，不是计划的内容。
    const other = {
      phases: [
        { tasks: [{ instruction: "甲", seatId: "s1" }], contextMode: "cumulative" as const, title: "一" },
        { tasks: [{ instruction: "乙", seatId: "s2" }], contextMode: "independent" as const, title: "二" },
      ],
    };
    expect(canonicalAgenda(plan)).toBe(canonicalAgenda(other));
  });

  it("没写的可选字段等于没有，不是 null", () => {
    // 否则 {a:1} 和 {a:1,b:undefined} 会被算成两份不同的计划。
    const withUndefined = { hostGoal: undefined, phases: plan.phases } as unknown as AgendaSpec;
    expect(canonicalAgenda(withUndefined)).toBe(canonicalAgenda(plan));
  });

  it("阶段顺序是计划的一部分，不排序", () => {
    // 先做哪一步就是计划本身；把它排序会让两份不同的计划哈希相同。
    const swapped: AgendaSpec = { phases: [plan.phases[1]!, plan.phases[0]!] };
    expect(canonicalAgenda(swapped)).not.toBe(canonicalAgenda(plan));
  });
});

describe("确认的是不是在架的那份", () => {
  const standing = { agendaId: "ag-1", revision: 3 };

  it("什么都不声明的调用照常放行", () => {
    // 斜杠命令和老客户端不知道版本号；为了防一个它们造不成的竞态而把它们
    // 拒掉，是拿一个能用的界面去换一件不会发生的事。
    expect(draftIdentityMatches(standing, {}).ok).toBe(true);
  });

  it("对得上就放行", () => {
    expect(draftIdentityMatches(standing, { agendaId: "ag-1", revision: 3 }).ok).toBe(true);
  });

  it("版本旧了要拦，并且说清差在哪一版", () => {
    // 这才是值得抓的那种错：人看着一份计划，按下去跑的是另一份，而且无声。
    const verdict = draftIdentityMatches(standing, { agendaId: "ag-1", revision: 2 });
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("第 2 版");
    expect(verdict.detail).toContain("第 3 版");
  });

  it("换了一份草案也要拦", () => {
    expect(draftIdentityMatches(standing, { agendaId: "ag-旧", revision: 3 }).ok).toBe(false);
  });
});

describe("短指纹", () => {
  it("截到 12 位，够长到值得比对", () => {
    // 太短会撞，太长没人愿意用眼睛核。
    expect(shortHash("a".repeat(64))).toHaveLength(12);
  });
});
