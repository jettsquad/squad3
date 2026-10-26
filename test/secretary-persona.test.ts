// 移植自 Squad 2.x packages/secretary/test/persona.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { foldPersona, personaPlan } from "../src/main/secretary/persona.ts";

describe("固定要求怎么带上", () => {
  it("后端支持 persona 时，走 seam", () => {
    const plan = personaPlan({ persona: "你说话要短", prompt: "总结一下", supported: true });
    expect(plan.persona).toBe("你说话要短");
    expect(plan.prompt).toBe("总结一下");
  });

  it("后端不支持时，折进提示词而不是丢掉", () => {
    // codex 和 dsh 都声明 persona: false，seam 会**拒绝**带 persona 的请求。
    // 之前每个秘书任务都无条件传 persona，于是这两种后端的秘书一件事也做不了。
    const plan = personaPlan({ persona: "你说话要短", prompt: "总结一下", supported: false });
    expect(plan.persona).toBeUndefined();
    expect(plan.prompt).toContain("你说话要短");
    expect(plan.prompt).toContain("总结一下");
  });

  it("折进去的时候要分节，不是拼在一起", () => {
    // 直接粘上去，固定要求会被读成任务的一部分：一个被要求「说话要短」的秘书
    // 会去总结这条要求，而不是遵守它。
    const folded = foldPersona("你说话要短", "总结一下");
    expect(folded.indexOf("你的身份")).toBeLessThan(folded.indexOf("本次任务"));
    expect(folded.indexOf("你说话要短")).toBeLessThan(folded.indexOf("总结一下"));
  });

  it("没有固定要求时原样返回", () => {
    expect(foldPersona(undefined, "总结一下")).toBe("总结一下");
    expect(foldPersona("   ", "总结一下")).toBe("总结一下");
  });

  it("没有固定要求时也不带 persona 字段", () => {
    // 传一个空 persona 同样会被不支持的后端拒掉。
    expect(personaPlan({ persona: "  ", prompt: "x", supported: true }).persona).toBeUndefined();
  });
});
