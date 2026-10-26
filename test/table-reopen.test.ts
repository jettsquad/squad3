// 移植自 Squad 2.x packages/table/test/reopen.test.ts @ 8dcb903
/**
 * 什么时候不再续接席位自己的对话。两条线都来自周一的真实记录：
 * 隔一晚续接，64 万 token 按缓存写入价整份重写；上下文到 80 万时，每跑一次工具就重读一遍。
 */
import { describe, expect, it } from "vitest";
import { REOPEN_ABOVE_CONTEXT_TOKENS, REOPEN_AFTER_IDLE_MS, reopenReason } from "../src/main/table/reopen.ts";

const now = 10_000_000_000;

describe("reopenReason", () => {
  it("没有对话就谈不上重开", () => {
    expect(reopenReason(undefined, now)).toBeUndefined();
  });

  it("刚用过、上下文不大：续接", () => {
    expect(reopenReason({ id: "s", usedAt: now - 60_000, contextTokens: 50_000 }, now)).toBeUndefined();
  });

  it("闲置超过缓存有效期：重开", () => {
    expect(reopenReason({ id: "s", usedAt: now - REOPEN_AFTER_IDLE_MS, contextTokens: 50_000 }, now)).toBe("idle");
  });

  it("缓存还热但上下文太大：也重开", () => {
    expect(reopenReason({ id: "s", usedAt: now - 60_000, contextTokens: REOPEN_ABOVE_CONTEXT_TOKENS }, now)).toBe(
      "oversized",
    );
  });

  it("不知道上次什么时候用的：当作已经凉了", () => {
    // 猜它还热是贵的那种错：冷续接要按最贵的价格把整段重写一遍。
    expect(reopenReason({ id: "s" }, now)).toBe("age-unknown");
  });

  it("后端没报上下文大小：只按时间判断", () => {
    expect(reopenReason({ id: "s", usedAt: now - 60_000 }, now)).toBeUndefined();
  });
});
