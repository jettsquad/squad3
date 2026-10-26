// 移植自 Squad 2.x packages/seat-claude-code/test/stream.test.ts @ 8dcb903
/**
 * Reading a finished run. Every fallback here is a real case, which is why
 * they are ordered rather than collapsed into "take whatever is there".
 */
import { describe, expect, it } from "vitest";
import { readStream } from "../src/main/seats/claude-code/stream.ts";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const result = (over: Record<string, unknown> = {}) =>
  line({ type: "result", subtype: "success", is_error: false, result: "信封里的文本", ...over });

describe("readStream", () => {
  it("prefers what was streamed over the envelope's summary", () => {
    // A long turn's envelope can summarise while the assistant blocks carry
    // what was actually said.
    expect(readStream(assistant("真正说的话") + result()).text).toBe("真正说的话");
  });

  it("falls back to the envelope when nothing streamed", () => {
    expect(readStream(result()).text).toBe("信封里的文本");
  });

  it("joins several assistant blocks in order", () => {
    expect(readStream(assistant("第一段") + assistant("第二段") + result()).text).toBe("第一段\n\n第二段");
  });

  it("reports an error envelope as failed while keeping the text", () => {
    // The text still travels: a failed run that explains itself is worth more
    // than a failed run that does not.
    const outcome = readStream(assistant("我做不了") + result({ is_error: true, subtype: "error_during_execution" }));
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toBe("我做不了");
    expect(outcome.subtype).toBe("error_during_execution");
  });

  it("失败时信封里的 API 错误跟在席位旁白后面，不被旁白盖掉", () => {
    // 文曲星被服务的安全分类器拦下：他先说了一句旁白，真正的原因在信封里。
    const error = "API Error: Sonnet 5.5's safeguards flagged this message. Details: `[reasoning_extraction]`";
    const outcome = readStream(
      assistant("我先读正文和记录文件的当前状态。") +
        result({ is_error: true, subtype: "error_during_execution", result: error }),
    );
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toBe(`我先读正文和记录文件的当前状态。\n\n${error}`);
  });

  it("成功时不动信封", () => {
    expect(readStream(assistant("正文") + result({ result: "API Error: 假的" })).text).toBe("正文");
  });

  it("treats a non-success subtype as failed even without is_error", () => {
    expect(readStream(result({ subtype: "error_max_turns", is_error: false }).valueOf()).failed).toBe(true);
  });

  it("falls back to plain text when there is no envelope at all", () => {
    // An older CLI, or a run that died before stream-json began.
    expect(readStream("就是一句普通输出")).toEqual({ text: "就是一句普通输出", failed: false });
  });

  it("treats no output at all as a failure", () => {
    // A seat that returns nothing and a seat that returned "" read the same
    // to everything downstream, so they must not read the same here.
    expect(readStream("   ")).toEqual({ text: "", failed: true });
  });

  it("survives a malformed line among good ones", () => {
    expect(readStream("{not json\n" + assistant("还在") + result()).text).toBe("还在");
  });
});

describe("usage", () => {
  const envelope = (over: Record<string, unknown> = {}) =>
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: {
        input_tokens: 2,
        output_tokens: 4,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 83625,
      },
      total_cost_usd: 0.501816,
      duration_ms: 5888,
      ...over,
    });

  it("reads the four counters, cost and duration", () => {
    // Field names taken from a live run, not from 1.x's parser — that one was
    // written for an older CLI whose envelope had none of modelUsage,
    // iterations or the cache-creation breakdown.
    expect(readStream(envelope()).usage).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 0,
      cacheCreationTokens: 83625,
      costUsd: 0.501816,
      durationMs: 5888,
    });
  });

  it("keeps cache tokens apart from input", () => {
    // The measurement this separation exists for: a turn whose entire prompt
    // was 「只回答 OK」 billed 2 input tokens and 83,625 of cache creation —
    // the host's own global CLAUDE.md, inherited by every seat. One summed
    // "input" number would bury that.
    const usage = readStream(envelope()).usage;
    expect(usage?.inputTokens).toBe(2);
    expect(usage?.cacheCreationTokens).toBeGreaterThan(80_000);
  });

  it("reports usage for a failed run too", () => {
    // A turn that burned tokens and then errored still cost what it cost.
    // Dropping it would make failures look free.
    const outcome = readStream(envelope({ is_error: true, subtype: "error_during_execution" }));
    expect(outcome.failed).toBe(true);
    expect(outcome.usage?.cacheCreationTokens).toBe(83625);
  });

  it("leaves usage absent when the envelope carried none", () => {
    // Absent, not zeroed: a turn that reported nothing and a turn that cost
    // nothing are different facts, and a total built from zeroes reads as
    // "cheap" rather than "unmeasured".
    expect(readStream(line({ type: "result", subtype: "success", result: "ok" })).usage).toBeUndefined();
  });

  it("treats a missing counter as zero rather than failing the whole read", () => {
    const partial = readStream(envelope({ usage: { input_tokens: 5 } }));
    expect(partial.usage).toMatchObject({ inputTokens: 5, outputTokens: 0, cacheReadTokens: 0 });
  });
});

describe("contextTokens", () => {
  const call = (usage: Record<string, number>) =>
    line({ type: "assistant", message: { content: [{ type: "text", text: "…" }], usage } });
  const done = line({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
    usage: { input_tokens: 9, output_tokens: 9, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 9 },
  });

  it("取最后一次模型调用的上下文，而不是整轮的累加", () => {
    // 整轮累加是花了多少钱；最后一次是下一次调用要读多少——决定还值不值得续接的是后者。
    const usage = readStream(
      call({ input_tokens: 2, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 }) +
        call({ input_tokens: 3, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 5_000 }) +
        done,
    ).usage;
    expect(usage?.contextTokens).toBe(305_003);
    expect(usage?.cacheReadTokens).toBe(900_000);
  });

  it("消息里没有用量时不瞎报", () => {
    expect(readStream(assistant("…") + done).usage?.contextTokens).toBeUndefined();
  });
});
