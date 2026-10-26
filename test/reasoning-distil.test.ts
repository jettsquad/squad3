// 移植自 Squad 2.x packages/reasoning/test/distil.test.ts @ 8dcb903
/**
 * Distillation is where a standard is separated from a conclusion, and where
 * a counter-example is allowed to narrow something instead of being filed as
 * a new claim that contradicts it.
 */
import { describe, expect, it } from "vitest";
import { buildDistilPrompt, parseDistillation } from "../src/main/reasoning/distil.ts";
import type { Criterion } from "../src/main/reasoning/criterion.ts";

const existing: Criterion = {
  id: "c-invisible",
  trigger: { action: ["design-mechanism"], features: ["automatic", "invisible-result"] },
  claim: "不可见的自动机制，其失败模式必然是静默的。",
  evidence: ["i-0"],
  status: "active",
};

describe("buildDistilPrompt", () => {
  it("asks for the standard rather than the conclusion", () => {
    // The distinction the whole system lives or dies on: a conclusion cannot
    // transfer to another situation, a standard can.
    const prompt = buildDistilPrompt({
      situation: { action: "design-mechanism", features: ["automatic"] },
      proposed: "自动折叠不提示",
      verdict: "要告知",
      candidates: [],
    });
    expect(prompt).toContain("写**标准**，不要写**结论**");
  });

  it("shows the existing boundary of each candidate", () => {
    // Without it the model proposes a counter-example against a boundary that
    // already covers the case.
    const prompt = buildDistilPrompt({
      situation: { action: "design-mechanism", features: ["automatic"] },
      proposed: "x",
      verdict: "y",
      candidates: [{ ...existing, boundary: "平凡可逆时不适用" }],
    });
    expect(prompt).toContain("已有边界：平凡可逆时不适用");
  });

  it("tells the model to write in the case's language, not the prompt's", () => {
    // 提示词整篇是中文，模型跟着指令的语言走是默认行为——一个英文案例
    // 因此可能产出中文判据，反之亦然。判据是这个人的标准，该留在他说话
    // 的那种语言里，所以这条约束必须明写。
    const prompt = buildDistilPrompt({
      situation: { action: "design-mechanism", features: ["automatic"] },
      proposed: "silently auto-fold",
      verdict: "must announce",
      candidates: [],
    });
    expect(prompt).toContain("用这次案例本身的语言写");
    // 并且要说清「指令的语言不算数」，否则模型仍可能默认跟随中文。
    expect(prompt).toContain("不决定判据的语言");
  });
});

describe("parseDistillation", () => {
  it("reads a counter-example that narrows an existing criterion", () => {
    const result = parseDistillation(
      JSON.stringify({
        relation: "counter-example",
        criterionId: "c-invisible",
        claim: "不可见的自动机制，其失败模式必然是静默的。",
        boundary: "动作平凡可逆时不适用（例如自动格式化）。",
      }),
      [existing],
    );
    expect(result.relation).toBe("counter-example");
    expect(result.boundary).toContain("平凡可逆");
  });

  it("tolerates prose around the object", () => {
    const result = parseDistillation('好的：\n{"relation":"new","claim":"要给出迁移成本估算"}\n', []);
    expect(result.claim).toBe("要给出迁移成本估算");
  });

  it("refuses a non-new relation that names no criterion", () => {
    // Downgrading it to `new` is how a library ends up holding two claims
    // that contradict each other, with nothing recording they ever met.
    expect(() => parseDistillation('{"relation":"revise","claim":"x"}', [existing])).toThrow(/哪一条/);
  });

  it("refuses a relation naming a criterion that was not a candidate", () => {
    expect(() => parseDistillation('{"relation":"reinforce","criterionId":"c-nope","claim":"x"}', [existing])).toThrow(
      /不在候选/,
    );
  });

  it("refuses an unknown relation", () => {
    expect(() => parseDistillation('{"relation":"merge","claim":"x"}', [])).toThrow(/未知的关系/);
  });

  it("refuses a distillation with no claim", () => {
    expect(() => parseDistillation('{"relation":"new"}', [])).toThrow(/没有给出主张/);
  });
});

describe("trigger features", () => {
  it("keeps the essential features the distillation chose", () => {
    const result = parseDistillation('{"relation":"new","claim":"x","triggerFeatures":["automatic"]}', []);
    expect(result.triggerFeatures).toEqual(["automatic"]);
  });

  it("refuses a feature outside the closed list instead of filtering it out", () => {
    // Filtering would narrow the trigger without saying so — the same failure
    // this field exists to fix, arriving by another route.
    expect(() => parseDistillation('{"relation":"new","claim":"x","triggerFeatures":["自作主张"]}', [])).toThrow(
      /触发特征/,
    );
  });

  it("leaves the field absent when the distillation gave none", () => {
    // Absent means "fall back to the instance's features", which is worse but
    // safe. Present-but-empty would mean "fires on the action alone", which is
    // a real choice the model can make — the two must stay distinguishable.
    expect(parseDistillation('{"relation":"new","claim":"x"}', [])).not.toHaveProperty("triggerFeatures");
  });

  it("accepts an empty list as a deliberately broad trigger", () => {
    expect(parseDistillation('{"relation":"new","claim":"x","triggerFeatures":[]}', []).triggerFeatures).toEqual([]);
  });
});
