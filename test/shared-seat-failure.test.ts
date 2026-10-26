// 移植自 Squad 2.x packages/shared/test/seat-failure.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { afterAttempt, isTransientFailure } from "../src/shared/agenda-machine.ts";
import { isClassifierBlock, seatFailureReason } from "../src/shared/seat-failure.ts";

const BLOCKED = [
  "我先读正文和记录文件的当前状态。",
  "",
  "正文改完。现在把两份评审原文追加进记录文件。",
  "",
  "API Error: Sonnet 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Sonnet 5.5.",
  "",
  "Try rephrasing the request in a new session or change your model.",
  "Details: `[reasoning_extraction]`",
  "Request ID: req_011Cg95ctaPSkf4RKtLGJg5F",
].join("\n");

describe("席位失败的真实原因", () => {
  it("API 错误比席位自己的旁白优先", () => {
    // 之前记成「我先读正文和记录文件的当前状态」，Lil X 当成普通没做完。
    const why = seatFailureReason(BLOCKED);
    expect(why).toContain("API Error");
    expect(why).toContain("[reasoning_extraction]");
    expect(why).not.toContain("我先读正文");
  });

  it("没有 API 错误时仍取第一行", () => {
    expect(seatFailureReason("⚠️ 该席位未能执行：spawn ENOENT\n更多")).toBe("⚠️ 该席位未能执行：spawn ENOENT");
    expect(seatFailureReason("")).toBe("");
  });

  it("认得出分类器拦截，认不出的不算", () => {
    expect(isClassifierBlock(BLOCKED)).toBe(true);
    expect(isClassifierBlock("Your response above was stopped by a safety classifier")).toBe(true);
    expect(isClassifierBlock("Reconnecting... 2/5 (workspace routing discovery failed)")).toBe(false);
    expect(isClassifierBlock("文件不存在")).toBe(false);
  });

  it("分类器拦截不算瞬时错误，不自动重试", () => {
    expect(isTransientFailure(BLOCKED)).toBe(false);
    // 对照：网络类照旧重试。
    expect(isTransientFailure("Reconnecting... 2/5 (workspace routing discovery failed)")).toBe(true);
  });

  it("决策点的原因里写明是分类器，不是网络", () => {
    const phase = { title: "评审", contextMode: "cumulative" as const, tasks: [{ seatId: "a", instruction: "x" }] };
    const step = afterAttempt(phase, 1, { seatFailed: { seat: "文曲星", why: seatFailureReason(BLOCKED) } });
    expect(step.kind).toBe("decide");
    expect(step.kind === "decide" ? step.why : "").toContain("安全分类器");
    const plain = afterAttempt(phase, 1, { seatFailed: { seat: "文曲星", why: "超时" } });
    expect(plain.kind === "decide" ? plain.why : "").not.toContain("安全分类器");
  });
});
