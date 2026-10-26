// 移植自 Squad 2.x packages/table/test/material-prompt.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { composeSeatPrompt } from "../src/shared/seat.ts";

const seat = {
  seatId: "seat-1",
  displayName: "甲",
  role: "架构师",
  systemPrompt: "认真作答。",
  backend: "dsh" as const,
};

const material = { materialId: "m1", name: "规格.md", text: "接口必须幂等。", addedAt: 0 };

describe("背景资料进席位提示词", () => {
  it("没有资料时不出现这一节", () => {
    expect(composeSeatPrompt({ seat, instruction: "开始", context: [] })).not.toContain("背景资料");
  });

  it("资料排在讨论之前", () => {
    // 资料是讨论发生的背景。先看到争论、后看到文件的席位，
    // 是在读一场关于它没见过的东西的辩论。
    const prompt = composeSeatPrompt({
      seat,
      instruction: "开始",
      context: ["【甲】那我们就这么定"],
      materials: [material],
    });
    expect(prompt.indexOf("背景资料")).toBeLessThan(prompt.indexOf("团队此前的讨论"));
  });

  it("指令永远在最后", () => {
    const prompt = composeSeatPrompt({
      seat,
      instruction: "请评审",
      context: ["【甲】说了点什么"],
      materials: [material],
    });
    expect(prompt.trimEnd().endsWith("请评审")).toBe(true);
  });

  it("资料原文在里面，并且带文件名", () => {
    const prompt = composeSeatPrompt({ seat, instruction: "开始", context: [], materials: [material] });
    expect(prompt).toContain("### 规格.md");
    expect(prompt).toContain("接口必须幂等。");
  });

  it("空数组等于没有资料", () => {
    expect(composeSeatPrompt({ seat, instruction: "开始", context: [], materials: [] })).not.toContain("背景资料");
  });
});
