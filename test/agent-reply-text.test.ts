// 移植自 Squad 2.x packages/shared/test/agent-reply-text.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { REASONING_ONLY_NOTICE, stripReasoning } from "../src/shared/agent-reply-text.ts";

describe("stripReasoning", () => {
  it("drops a think block and keeps the answer", () => {
    expect(stripReasoning("<think>先考虑一下选型</think>我建议用 Postgres。")).toBe("我建议用 Postgres。");
  });

  it("handles the other tags the same way", () => {
    expect(stripReasoning("<thinking>x</thinking>答案")).toBe("答案");
    expect(stripReasoning("<reasoning>x</reasoning>答案")).toBe("答案");
    expect(stripReasoning("<thought>x</thought>答案")).toBe("答案");
  });

  it("ignores case and attributes on the tag", () => {
    expect(stripReasoning('<Think depth="2">x</THINK>答案')).toBe("答案");
  });

  it("drops several blocks and closes the gaps they leave", () => {
    expect(stripReasoning("<think>a</think>\n\n第一点\n\n<think>b</think>\n\n第二点")).toBe("第一点\n\n第二点");
  });

  // The turn ended mid-thought: nothing after the open tag is an answer.
  it("drops everything after an unclosed tag", () => {
    expect(stripReasoning("答案在这里。\n<think>还没想完就被截断了")).toBe("答案在这里。");
  });

  // Neither empty (indistinguishable from a silent failure) nor the raw
  // thought (the thing this exists to keep out of the transcript).
  it("replaces a reply that was nothing but reasoning with a notice", () => {
    expect(stripReasoning("<think>整条回复都是思考</think>")).toBe(REASONING_ONLY_NOTICE);
    expect(stripReasoning("<think>被截断的思考，没有闭合标签")).toBe(REASONING_ONLY_NOTICE);
  });

  it("leaves an actually empty reply empty", () => {
    expect(stripReasoning("   ")).toBe("");
  });

  it("leaves an ordinary reply untouched", () => {
    expect(stripReasoning("我同意甲的方案。")).toBe("我同意甲的方案。");
  });

  it("does not eat prose that merely mentions thinking", () => {
    expect(stripReasoning("我think这个方案更好")).toBe("我think这个方案更好");
  });
});
