// 移植自 Squad 2.x packages/shared/test/agent-check.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { overallOf, reconcileReachability, type AgentCheckReport, type CheckResult } from "../src/shared/index.ts";

const report = (...checks: CheckResult[]): AgentCheckReport => ({
  templateId: "a",
  displayName: "甲",
  checks,
});
const check = (outcome: CheckResult["outcome"]): CheckResult => ({ name: "n", outcome, detail: "d" });

// 这一组来自 2.x 工作区尚未提交的改动（8dcb903 之后）。
describe("reachability evidence", () => {
  it("uses a successful real request when HEAD timed out, retaining the diagnostic", () => {
    const head = { name: "地址可达", outcome: "fail" as const, detail: "HEAD timeout" };
    const result = reconcileReachability(head, check("ok"));
    expect(result.outcome).toBe("ok");
    expect(result.detail).toContain("HEAD timeout");
    expect(overallOf(report(result, check("ok")))).toBe("ok");
  });

  it("keeps reachability failures when the real request failed or did not run", () => {
    const head = check("fail");
    for (const outcome of ["fail", "unknown", "skipped"] as const) {
      expect(reconcileReachability(head, check(outcome))).toBe(head);
    }
  });

  it("does not turn other configuration failures into success", () => {
    const result = reconcileReachability(check("fail"), check("ok"));
    expect(overallOf(report(result, check("fail")))).toBe("fail");
    expect(reconcileReachability(check("skipped"), check("ok")).outcome).toBe("skipped");
  });
});

describe("overallOf", () => {
  it("全过才是过", () => {
    expect(overallOf(report(check("ok"), check("ok")))).toBe("ok");
  });

  it("有一项失败就是失败", () => {
    expect(overallOf(report(check("ok"), check("fail"), check("skipped")))).toBe("fail");
  });

  it("没跑成（unknown）不算过", () => {
    // 想查而查不成，是缺证据；在一个绿勾里它和查过了长得一模一样。
    expect(overallOf(report(check("ok"), check("unknown")))).toBe("incomplete");
    expect(overallOf(report(check("unknown")))).not.toBe("ok");
  });

  it("不适用（skipped）算过", () => {
    // 「订阅模式不需要密钥」不是没跑成，是没有可查的东西——那是完整的答案。
    // 混成一件事的时候，一个配置完全正确的订阅 agent 会自称「有检查没跑成」。
    expect(overallOf(report(check("ok"), check("skipped")))).toBe("ok");
    expect(overallOf(report(check("skipped"), check("skipped"), check("ok")))).toBe("ok");
  });

  it("失败压过一切", () => {
    expect(overallOf(report(check("skipped"), check("fail"), check("unknown")))).toBe("fail");
  });

  it("一项都没有也不算过", () => {
    // 空报告和全跳过是同一句话：没有取到任何证据。这里给 "ok" 就等于
    // 一次什么都没检查的检查，报了个通过。
    expect(overallOf(report())).toBe("incomplete");
  });
});
