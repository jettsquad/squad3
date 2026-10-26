// 移植自 Squad 2.x packages/secretary/test/tasks.test.ts @ 8dcb903
/**
 * The refusals, which are the point of this plugin.
 *
 * These documents are read as fact by everything downstream — the checkpoint
 * becomes every later round's history, the hand-off becomes the next team's
 * starting point. A missing section does not announce itself; it reads as a
 * section with nothing in it. So partial output is refused rather than
 * stored, and the refusal names what was missing.
 */
import { describe, expect, it } from "vitest";
import {
  agendaFromReplyWith,
  compressProjectMemoryWith,
  writeCheckpointWith,
  writeTerminationWith,
  type TextTaskRunner,
} from "../src/main/secretary/tasks.ts";
import { buildProjectMemoryPrompt, projectMemoryBodyLimit } from "../src/main/secretary/project-memory.ts";
import { PROJECT_MEMORY_RULES_BEGIN, withProjectMemoryRules } from "../src/shared/index.ts";
import { CHECKPOINT_HEADING_LIST } from "../src/main/secretary/checkpoint.ts";
import { TERMINATION_SUMMARY_HEADINGS } from "../src/main/secretary/termination.ts";

const answering =
  (text: string, stopReason = "completed"): TextTaskRunner =>
  async () => ({ text, stopReason });

const wholeCheckpoint = CHECKPOINT_HEADING_LIST.map((heading) => `${heading}\n内容`).join("\n\n");
const wholeTermination = TERMINATION_SUMMARY_HEADINGS.map((heading) => `${heading}\n内容`).join("\n\n");

const checkpointInput = { hostGoal: "把窗口装配做完", turns: [{ speaker: "甲", text: "先修渲染层" }] };

const terminationInput = {
  objective: "把窗口装配做完",
  reason: "主持人叫停",
  completed: ["修好了渲染层"],
  remaining: ["阈值还没接"],
  artifacts: [],
  discussion: ["【甲】先修渲染层"],
};

describe("writeCheckpointWith", () => {
  it("returns the checkpoint when every heading is there", async () => {
    await expect(writeCheckpointWith(answering(wholeCheckpoint), checkpointInput)).resolves.toBe(wholeCheckpoint);
    // Stored with the canonical headings whatever level the secretary used.
    await expect(
      writeCheckpointWith(answering(wholeCheckpoint.replace("## 当前目标", "# 当前目标")), checkpointInput),
    ).resolves.toBe(wholeCheckpoint);
  });

  it("refuses a checkpoint with a missing heading, and names it", async () => {
    // 「未决分歧」 is the one that matters most. Gone, the checkpoint does not
    // read as broken — it reads as a team that agreed, and every later round
    // inherits a consensus that never happened.
    const withoutDisagreement = wholeCheckpoint.replace("## 未决分歧\n内容", "");
    await expect(writeCheckpointWith(answering(withoutDisagreement), checkpointInput)).rejects.toThrow(/未决分歧/);
  });

  it("refuses output that stopped for any reason other than completion", async () => {
    // max-tokens is the dangerous one: it returns real text that stops
    // partway, so it can pass heading validation and still end mid-sentence.
    await expect(writeCheckpointWith(answering(wholeCheckpoint, "max-tokens"), checkpointInput)).rejects.toThrow(
      /max-tokens/,
    );
  });

  it("passes the built prompt to the runner rather than the raw input", async () => {
    let seen = "";
    const capture: TextTaskRunner = async (_label, prompt) => {
      seen = prompt;
      return { text: wholeCheckpoint, stopReason: "completed" };
    };
    await writeCheckpointWith(capture, checkpointInput);
    expect(seen).toContain("把窗口装配做完");
    expect(seen).toContain("【甲】先修渲染层");
  });
});

describe("writeTerminationWith", () => {
  it("returns the hand-off when every heading is there", async () => {
    await expect(writeTerminationWith(answering(wholeTermination), terminationInput)).resolves.toBe(wholeTermination);
  });

  it("refuses a hand-off with a hole, and names it", async () => {
    const withoutRemaining = wholeTermination.replace("## 未完成事项\n内容", "");
    await expect(writeTerminationWith(answering(withoutRemaining), terminationInput)).rejects.toThrow(/未完成事项/);
  });

  it("refuses a hand-off that did not run to completion", async () => {
    await expect(writeTerminationWith(answering(wholeTermination, "error"), terminationInput)).rejects.toThrow(
      /未完成/,
    );
  });
});

describe("把秘书的回复转成议程", () => {
  const seats = [{ seatId: "seat-1", displayName: "吴二" }];
  const spec = JSON.stringify({
    phases: [{ title: "干活", contextMode: "cumulative", tasks: [{ seatId: "seat-1", instruction: "写" }] }],
  });

  it("回复里带 @ 也能转", async () => {
    // 秘书的回复里当然会出现「@吴二」——那是它在讨论里点名。
    // 公开性检查针对的是主持人自己写的句子，拿它去卡记录里的原文，
    // 会让每一次转换都被一条主持人根本没写过的句子挡下来。
    const draft = await agendaFromReplyWith(async () => ({ text: spec, stopReason: "completed" }), {
      command: "把上面这段安排转成结构化议程。",
      topic: "队",
      seats,
      reply: "📣 @吴二 —— 主人口谕：请撰写一份自我介绍。",
    });
    expect(draft.phases).toHaveLength(1);
  });

  it("主持人自己的指令里带 @ 仍然被拒", async () => {
    // 那一条才是这个检查存在的理由：@ 指向只有主持人看得到的材料，
    // 而秘书是看不到私有材料的。
    await expect(
      agendaFromReplyWith(async () => ({ text: spec, stopReason: "completed" }), {
        command: "照着 @我的私有笔记 排",
        topic: "队",
        seats,
        reply: "随便",
      }),
    ).rejects.toThrow(/@/);
  });
});

describe("compressProjectMemoryWith", () => {
  const input = { file: "CLAUDE.md", text: "# 很长的项目文件\n" + "旧内容\n".repeat(10_000) };

  it("收下一份在上限内的正文", async () => {
    await expect(compressProjectMemoryWith(answering("# 项目\n精简后"), input)).resolves.toBe("# 项目\n精简后");
  });

  it("压完还超上限：拒收，不写进人家的项目", async () => {
    const tooLong = "字".repeat(projectMemoryBodyLimit() + 1);
    await expect(compressProjectMemoryWith(answering(tooLong), input)).rejects.toThrow("超过上限");
  });

  it("空的：拒收", async () => {
    await expect(compressProjectMemoryWith(answering("   "), input)).rejects.toThrow("空");
  });

  it("提示词里带着规则，但不带原文件里那份规则块", () => {
    const prompt = buildProjectMemoryPrompt({ file: "CLAUDE.md", text: withProjectMemoryRules("# 项目\n正文") });
    expect(prompt).toContain("@路径");
    expect(prompt).not.toContain(PROJECT_MEMORY_RULES_BEGIN);
    expect(prompt).toContain("正文");
  });
});
