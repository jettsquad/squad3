// 移植自 Squad 2.x packages/seat-codex/test/stream.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { readCodexStream } from "../src/main/seats/codex/stream.ts";

const line = (o: unknown) => JSON.stringify(o);
const msg = (text: string) => line({ type: "item.completed", item: { type: "agent_message", text } });

describe("readCodexStream", () => {
  it("取最后一条 agent_message，不是拼起来", () => {
    // 一轮会发好几条 agent_message，只有最后一条是答复。拼起来就成了
    // 一份复述自己思考过程的回答。
    const got = readCodexStream([msg("先想想"), msg("最终答复")].join("\n"));
    expect(got.text).toBe("最终答复");
    expect(got.failed).toBe(false);
  });

  it("非 JSON 的行跳过（stderr 进度会混进来）", () => {
    expect(readCodexStream(["正在思考…", msg("答复"), ""].join("\n")).text).toBe("答复");
  });

  it("被截断的最后一行不会让整个解析炸掉", () => {
    // 进程被杀时最后一行写了一半，这是常态。
    expect(readCodexStream([msg("答复"), '{"type":"turn.comp'].join("\n")).text).toBe("答复");
  });

  it("用量来自 turn.completed，缓存单独一列", () => {
    // 数字换成了子集关系：cached 是 input 的一部分，原来那组（输入 10、
    // 缓存 90）按 codex 的口径不可能出现。
    const raw = [
      msg("答复"),
      line({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 5 } }),
    ].join("\n");
    expect(readCodexStream(raw).usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 90,
      cacheCreationTokens: 0,
    });
  });

  it("没报用量就是没有，不是 0", () => {
    // 「报了 0」和「没报」是两件事，只有一件是好消息。
    expect(readCodexStream(msg("答复")).usage).toBeUndefined();
    expect(readCodexStream([msg("答复"), line({ type: "turn.completed" })].join("\n")).usage).toBeUndefined();
  });

  it("turn.failed 和 error 都算失败，并带上原因", () => {
    const got = readCodexStream([msg("半截"), line({ type: "turn.failed", message: "配额用完了" })].join("\n"));
    expect(got.failed).toBe(true);
    expect(got.detail).toBe("配额用完了");
  });

  it("没有答复本身就是失败", () => {
    // 空回复读起来像「这位没什么要说的」——那是唯一一种会掩盖坏掉的运行的读法。
    expect(readCodexStream("").failed).toBe(true);
    expect(readCodexStream(msg("   ")).failed).toBe(true);
  });
});

describe("用量口径", () => {
  const turn = (usage: Record<string, number>): string =>
    [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "答复" } }),
      JSON.stringify({ type: "turn.completed", usage }),
    ].join("\n");

  it("codex 的 input_tokens 含缓存，要减掉", () => {
    // 两家口径不同：claude 的 input_tokens 不含缓存，codex 的含。原样上报会
    // 让同一列在混编团队里表示两种东西，总数没有明确含义。
    //
    // 靠算术定的，不是靠读文档：按「不含」解释，同一个 thread 续接后的总
    // prompt 会比它续接的那次还小（22,922 < 30,547），而对话只会变长。
    const out = readCodexStream(
      turn({ input_tokens: 17619, cached_input_tokens: 12928, output_tokens: 5, cache_write_input_tokens: 0 }),
    );
    expect(out.usage?.inputTokens).toBe(4691);
    expect(out.usage?.cacheReadTokens).toBe(12928);
  });

  it("缓存比输入还大时归零，不给负数", () => {
    // 上游换算一变就可能出现，而一个负数会把团队总数减小——比缺一个数更糟。
    const out = readCodexStream(turn({ input_tokens: 100, cached_input_tokens: 500, output_tokens: 1 }));
    expect(out.usage?.inputTokens).toBe(0);
  });

  it("新建缓存不再被丢掉", () => {
    // 原来写死成 0。建缓存是贵的那一档，一列永远是零就藏掉了最该看的轮次。
    const out = readCodexStream(
      turn({ input_tokens: 900, cached_input_tokens: 100, output_tokens: 2, cache_write_input_tokens: 350 }),
    );
    expect(out.usage?.cacheCreationTokens).toBe(350);
  });
});
