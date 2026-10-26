// 移植自 Squad 2.x packages/secretary/test/checkpoint.test.ts @ 8dcb903
/**
 * The checkpoint is what every later turn sees instead of the discussion
 * itself, so its shape is load-bearing: a heading the assembler cannot find
 * is context silently lost, and a disagreement flattened into consensus is
 * a minority position deleted with no trace.
 */

import { describe, expect, it } from "vitest";
import {
  buildCheckpointPrompt,
  normalizeCheckpoint,
  validateCheckpoint,
  CHECKPOINT_HEADINGS,
  CHECKPOINT_HEADING_LIST,
} from "../src/main/secretary/checkpoint.ts";

const turns = [
  { speaker: "吴二", text: "契约层有三处不一致" },
  { speaker: "郑三", text: "性能没问题，但缺回滚方案" },
];

describe("buildCheckpointPrompt", () => {
  it("asks for all four headings", () => {
    const prompt = buildCheckpointPrompt({ hostGoal: "评审技术方案", turns });
    for (const heading of CHECKPOINT_HEADING_LIST) expect(prompt).toContain(heading);
  });

  it("carries the discussion and who said what", () => {
    const prompt = buildCheckpointPrompt({ hostGoal: "评审技术方案", turns });
    expect(prompt).toContain("吴二");
    expect(prompt).toContain("契约层有三处不一致");
  });

  it("tells a first checkpoint nothing about continuation", () => {
    const prompt = buildCheckpointPrompt({ hostGoal: "评审", turns });
    expect(prompt).not.toContain("接续");
    expect(prompt).not.toContain("上一份检查点");
  });

  it("hands a continuation the previous checkpoint as input, not as raw material", () => {
    // Re-summarising a summary compounds its losses; settled items are
    // inherited rather than re-derived.
    const prompt = buildCheckpointPrompt({
      hostGoal: "评审",
      previousCheckpoint: `${CHECKPOINT_HEADINGS.settled}\n- 采用方案B`,
      turns,
    });
    expect(prompt).toContain("采用方案B");
    expect(prompt).toContain("直接继承");
  });

  it("instructs a continuation to re-adjudicate open disagreements", () => {
    // Append-only would leave settled arguments listed forever until the
    // section stopped being believed.
    const prompt = buildCheckpointPrompt({ hostGoal: "评审", previousCheckpoint: "旧检查点", turns });
    expect(prompt).toContain("逐条重新裁定");
  });

  it("forbids flattening disagreement into consensus", () => {
    expect(buildCheckpointPrompt({ hostGoal: "评审", turns })).toContain("不要把分歧写成共识");
  });

  it("still produces a usable prompt when nothing new was said", () => {
    const prompt = buildCheckpointPrompt({ hostGoal: "评审", previousCheckpoint: "旧检查点", turns: [] });
    expect(prompt).toContain("（无新增讨论）");
  });
});

describe("validateCheckpoint", () => {
  const complete = [
    `${CHECKPOINT_HEADINGS.goal}\n完成技术方案评审`,
    `${CHECKPOINT_HEADINGS.settled}\n- 采用方案B`,
    `${CHECKPOINT_HEADINGS.open}\n- 回滚策略：吴主张灰度，郑主张全量`,
    `${CHECKPOINT_HEADINGS.index}\n- review-A.md：契约层问题清单`,
  ].join("\n\n");

  it("accepts a checkpoint carrying every heading", () => {
    expect(validateCheckpoint(complete)).toEqual({ ok: true });
  });

  it("names what is missing rather than accepting a degraded checkpoint", () => {
    // This document becomes the basis of every later turn — accepting a
    // malformed one degrades everything downstream, invisibly.
    const withoutOpen = complete.replace(`${CHECKPOINT_HEADINGS.open}\n- 回滚策略：吴主张灰度，郑主张全量`, "");
    const result = validateCheckpoint(withoutOpen);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing).toEqual([CHECKPOINT_HEADINGS.open]);
  });

  it("reports every missing heading at once", () => {
    const result = validateCheckpoint("秘书随口写的一段话");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.missing).toEqual(CHECKPOINT_HEADING_LIST);
  });
});

describe("检查点带上主持人的判断标准", () => {
  it("判据排在指令之后、材料之前", () => {
    // 它限定的是「怎么写这份检查点」。放在讨论材料后面，读起来就成了对材料
    // 的评论，而不是对写法的要求。
    const prompt = buildCheckpointPrompt({
      hostGoal: "目标",
      turns: [{ speaker: "甲", text: "甲说的话" }],
      criteria: "— 分歧不许压成共识",
    });
    expect(prompt).toContain("分歧不许压成共识");
    expect(prompt.indexOf("分歧不许压成共识")).toBeLessThan(prompt.indexOf("甲说的话"));
  });

  it("没有判据时不留空段落", () => {
    const prompt = buildCheckpointPrompt({ hostGoal: "目标", turns: [] });
    expect(prompt).not.toContain("主持人自己定下的判断标准");
  });
});

describe("检查点标题的级别", () => {
  const sections = (marks: readonly string[]): string =>
    ["当前目标", "已定事项", "未决分歧", "产出索引"].map((name, index) => `${marks[index]} ${name}\n内容`).join("\n\n");

  it("一级、三级标题也认，四节齐全就通过", () => {
    // 真实的一次折叠：dsh 秘书第一节写成了 `# 当前目标`，一份完整的检查点就为
    // 一个 `#` 被整份丢掉。四节是平级的，没有代码按级别读它们。
    expect(validateCheckpoint(sections(["#", "##", "##", "##"]))).toEqual({ ok: true });
    expect(validateCheckpoint(sections(["###", "###", "###", "###"]))).toEqual({ ok: true });
  });

  it("放宽的只是 # 的个数，少了哪一节照样拒收", () => {
    const result = validateCheckpoint(sections(["#", "##", "##", "##"]).replace("## 未决分歧\n内容", ""));
    expect(result).toEqual({ ok: false, missing: [CHECKPOINT_HEADINGS.open] });
  });

  it("正文里提到这几个字不算这一节", () => {
    const text = sections(["##", "##", "##", "##"]).replace("## 未决分歧", "这里没有未决分歧");
    expect(validateCheckpoint(text)).toEqual({ ok: false, missing: [CHECKPOINT_HEADINGS.open] });
  });

  it("存之前统一改成二级标题，别的标题不动", () => {
    const text = `# 当前目标\n内容\n\n### 已定事项\n- 一\n\n#### 细节\n\n## 未决分歧\n内容\n\n# 产出索引 #\n内容`;
    expect(normalizeCheckpoint(text)).toBe(
      `## 当前目标\n内容\n\n## 已定事项\n- 一\n\n#### 细节\n\n## 未决分歧\n内容\n\n## 产出索引\n内容`,
    );
  });
});
