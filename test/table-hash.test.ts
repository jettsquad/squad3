// 移植自 Squad 2.x packages/table/test/hash.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { agendaHash } from "../src/main/table/hash.ts";
import type { AgendaSpec } from "../src/shared/index.ts";

const plan: AgendaSpec = {
  phases: [{ title: "一", contextMode: "cumulative", tasks: [{ seatId: "s1", instruction: "甲" }] }],
};

describe("确认指纹", () => {
  it("同一份计划哈希稳定", () => {
    expect(agendaHash(plan)).toBe(agendaHash(plan));
  });

  it("字段顺序不同但计划相同，哈希也相同", () => {
    // 规范化的意义就在这：不然哈希记的是序列化器的心情。
    const other = {
      phases: [{ tasks: [{ instruction: "甲", seatId: "s1" }], contextMode: "cumulative" as const, title: "一" }],
    };
    expect(agendaHash(other)).toBe(agendaHash(plan));
  });

  it("改一个字就变", () => {
    const edited: AgendaSpec = { phases: [{ ...plan.phases[0]!, title: "一改" }] };
    expect(agendaHash(edited)).not.toBe(agendaHash(plan));
  });
});
