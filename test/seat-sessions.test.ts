// 移植自 Squad 2.x packages/seat-runtime/test/sessions.test.ts @ 8dcb903
/**
 * 席位的 CLI 会话记账。
 *
 * 这里的每一条都对应一个会真的咬人的场景：会话串味、失败之后永久卡死、
 * 折叠之后席位拿着被替换掉的历史继续答。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetSeatSession,
  forgetSeatSessions,
  rememberSeatSession,
  resetSeatSessions,
  restoreSeatSessions,
  resumeWasRejected,
  seatSession,
  seatSessionId,
  snapshotSeatSessions,
} from "../src/main/seat-runtime/sessions.ts";

describe("席位会话记账", () => {
  beforeEach(() => resetSeatSessions());

  it("同一个 agent 在两个团队里是两段对话", () => {
    // 周同时坐在两支团队里，两边的历史绝不能串。键是（父会话，席位名）。
    rememberSeatSession("team-a", "周", "sess-a");
    rememberSeatSession("team-b", "周", "sess-b");
    expect(seatSessionId("team-a", "周")).toBe("sess-a");
    expect(seatSessionId("team-b", "周")).toBe("sess-b");
  });

  it("没记过就是没有，不是空字符串", () => {
    // 调用方靠 undefined 决定「这是首轮，发全量窗口」。
    expect(seatSessionId("team-a", "周")).toBeUndefined();
  });

  it("没有 label 的请求不参与记账", () => {
    // 未命名的运行没有地址，硬记会把两个不同的东西挤到同一个键上。
    rememberSeatSession("team-a", undefined, "sess-x");
    expect(seatSessionId("team-a", undefined)).toBeUndefined();
  });

  it("忘掉一个不影响同团队的其他席位", () => {
    rememberSeatSession("team-a", "周", "sess-1");
    rememberSeatSession("team-a", "卫七", "sess-2");
    forgetSeatSession("team-a", "周");
    expect(seatSessionId("team-a", "周")).toBeUndefined();
    expect(seatSessionId("team-a", "卫七")).toBe("sess-2");
  });

  it("折叠清掉这个团队的全部，别的团队不动", () => {
    // 检查点替换了 Squad 发出去的历史，但 CLI 手里那份没法叫它忘掉——只能
    // 把整段对话丢掉。丢的范围必须精确到这一个父会话。
    rememberSeatSession("team-a", "周", "s1");
    rememberSeatSession("team-a", "卫七", "s2");
    rememberSeatSession("team-b", "周", "s3");
    forgetSeatSessions("team-a");
    expect(seatSessionId("team-a", "周")).toBeUndefined();
    expect(seatSessionId("team-a", "卫七")).toBeUndefined();
    expect(seatSessionId("team-b", "周")).toBe("s3");
  });

  it("前缀相近的父会话不会被误清", () => {
    // `team-a` 和 `team-a2` 只差一个字符，按裸前缀匹配会把后者一起清掉。
    rememberSeatSession("team-a", "甲", "s1");
    rememberSeatSession("team-a2", "甲", "s2");
    forgetSeatSessions("team-a");
    expect(seatSessionId("team-a2", "甲")).toBe("s2");
  });
});

describe("重启前后的记账（持久化）", () => {
  beforeEach(() => resetSeatSessions());

  it("只吐出这一个父会话名下的、去掉前缀的记账", () => {
    rememberSeatSession("team-a", "周", "s1");
    rememberSeatSession("team-a", "卫七", "s2");
    rememberSeatSession("team-b", "周", "s3");
    expect(snapshotSeatSessions("team-a")).toEqual({ 周: { id: "s1" }, 卫七: { id: "s2" } });
  });

  it("没记过任何东西，吐出空对象而不是抛错", () => {
    expect(snapshotSeatSessions("team-never-seen")).toEqual({});
  });

  it("重启（清空内存）之后，读回保存的记账能恢复续接", () => {
    rememberSeatSession("team-a", "周", "s1");
    const saved = snapshotSeatSessions("team-a");
    resetSeatSessions(); // 模拟进程重启：内存清空，磁盘上的 saved 还在
    expect(seatSessionId("team-a", "周")).toBeUndefined();
    restoreSeatSessions("team-a", saved);
    expect(seatSessionId("team-a", "周")).toBe("s1");
  });

  it("上次什么时候用的、上下文多大，跟着一起存、一起读回", () => {
    rememberSeatSession("team-a", "周", "s1", { usedAt: 1000, contextTokens: 250_000 });
    const saved = snapshotSeatSessions("team-a");
    resetSeatSessions();
    restoreSeatSessions("team-a", saved);
    expect(seatSession("team-a", "周")).toEqual({ id: "s1", usedAt: 1000, contextTokens: 250_000 });
  });

  it("旧格式（只有 id 的字符串）也能读回，只是不知道年龄", () => {
    restoreSeatSessions("team-a", { 周: "s1" });
    expect(seatSession("team-a", "周")).toEqual({ id: "s1" });
  });
});

describe("认出「这段对话没了」", () => {
  const id = "dda3fe21-958d-4e17-9c95-8abe02d795c9";

  it("失败里点了我们传过去的 id，就是这段对话没了", () => {
    // claude 的原话，一字不差；它在调模型之前就退出，所以这一次不花钱。
    expect(resumeWasRejected(id, `No conversation found with session ID: ${id}`)).toBe(true);
  });

  it("别的失败一律不重试", () => {
    // 最常见的是静默超时被看门狗杀掉。重试它等于再等一次那个静默。
    expect(resumeWasRejected(id, "这个席位连续 15 分钟没有输出，已停止。")).toBe(false);
    expect(resumeWasRejected(id, "MISSING_CREDENTIAL: 没有 API key")).toBe(false);
  });

  it("本来就没续接的turn，谈不上续接失败", () => {
    expect(resumeWasRejected(undefined, `No conversation found with session ID: ${id}`)).toBe(false);
    expect(resumeWasRejected("", "whatever")).toBe(false);
  });
});
