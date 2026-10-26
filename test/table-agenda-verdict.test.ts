// 移植自 Squad 2.x packages/console/test/agenda-verdict.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { agendaEditIsLegal } from "../src/main/table/agenda-verdict.ts";

const phase = { title: "干活", contextMode: "cumulative" as const, tasks: [{ seatId: "s1", instruction: "写" }] };

describe("确认时能改什么", () => {
  it("没有待确认的草案就不能确认", () => {
    // 「秘书提议、主持人确认」只有在「永远有一份提议可确认」时才是规矩。
    expect(agendaEditIsLegal(undefined, { phases: [phase] })).toEqual({
      ok: false,
      detail: "没有待确认的议程。",
    });
  });

  it("原样确认可以", () => {
    expect(agendaEditIsLegal({ phases: [phase] }, undefined).ok).toBe(true);
  });

  it("改阶段内容可以", () => {
    // 主持人本来就有权改：改标题、改指令、改执行人、删掉一个阶段。
    const edited = { phases: [{ ...phase, title: "改过的标题" }] };
    expect(agendaEditIsLegal({ phases: [phase] }, edited).ok).toBe(true);
  });

  it("一个阶段都不剩，等于丢弃而不是执行", () => {
    // 空议程跑起来什么也不做，却会把团队标成「议程进行中」。
    expect(agendaEditIsLegal({ phases: [phase] }, { phases: [] }).ok).toBe(false);
  });
});
