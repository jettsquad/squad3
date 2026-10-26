// 移植自 Squad 2.x packages/reasoning/test/criterion.test.ts @ 8dcb903
/**
 * The store has to survive Squad. These files are the user's own asset — the
 * design calls them worth more than any single project — so the format is
 * plain Markdown a person can read, and every round trip through it has to
 * come back unchanged.
 */
import { describe, expect, it } from "vitest";
import {
  criterionFromMarkdown,
  criterionToMarkdown,
  instanceToMarkdown,
  type Criterion,
} from "../src/main/reasoning/criterion.ts";

const criterion: Criterion = {
  id: "c-invisible-automatic",
  trigger: {
    action: ["design-mechanism"],
    features: ["automatic", "invisible-result"],
  },
  claim: "不可见的自动机制，其失败模式必然是静默的。要么让结果可见，要么不要自动。",
  boundary: "动作平凡可逆时不适用（例如自动格式化）。",
  evidence: ["i-checkpoint-fold", "i-artifact-silent"],
  status: "active",
};

describe("criterion round trip", () => {
  it("comes back unchanged", () => {
    expect(criterionFromMarkdown(criterionToMarkdown(criterion))).toEqual(criterion);
  });

  it("keeps the claim readable as prose, not as a field", () => {
    // Structure gets it found; prose gets it understood. Flattening the claim
    // into front matter would lose the only part worth having.
    expect(criterionToMarkdown(criterion)).toContain("## 主张\n不可见的自动机制");
  });

  it("survives a criterion that has grown no boundary yet", () => {
    const fresh: Criterion = { ...criterion, boundary: undefined, evidence: [] };
    const back = criterionFromMarkdown(criterionToMarkdown(fresh));
    expect(back).not.toHaveProperty("boundary");
    expect(back.evidence).toEqual([]);
  });

  it("refuses a feature flag outside the closed list", () => {
    // Not dropped. A silently discarded flag narrows the trigger without
    // saying so, and the criterion then stops matching what it was written
    // for — which looks exactly like a criterion nobody ever wrote.
    // Targeted at the features LINE. A loose `.replace("automatic", …)` hits
    // the id first — `c-invisible-automatic` — leaving the trigger untouched
    // and the assertion passing for a reason that has nothing to do with the
    // closed list.
    const tampered = criterionToMarkdown(criterion).replace(/^features: .*$/m, "features: 自作主张, invisible-result");
    expect(() => criterionFromMarkdown(tampered)).toThrow(/特征标记/);
  });

  it("refuses a file whose claim is missing", () => {
    const gutted = criterionToMarkdown(criterion).replace("## 主张", "## 想法");
    expect(() => criterionFromMarkdown(gutted, "c-1.md")).toThrow(/主张/);
  });

  it("names the file it could not read", () => {
    expect(() => criterionFromMarkdown("没有 front matter", "坏文件.md")).toThrow(/坏文件\.md/);
  });
});

describe("instance", () => {
  it("keeps the human's reason, which is the line worth keeping", () => {
    const text = instanceToMarkdown({
      id: "i-1",
      situation: { action: "design-mechanism", features: ["automatic"] },
      proposed: "自动折叠，不提示",
      verdict: "改成折叠后在系统通道告知",
      reason: "不可见的东西没法纠正",
      at: "2026-08-21T00:00:00.000Z",
    });
    expect(text).toContain("## 理由\n不可见的东西没法纠正");
  });
});
