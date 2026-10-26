// 移植自 Squad 2.x packages/shared/src/agent-check.ts @ 8dcb903
/**
 * agent-check.ts — what a configuration test can honestly report.
 *
 * Four separate answers rather than one verdict, because they fail for
 * unrelated reasons and each one has a different fix: the CLI is not
 * installed, the seat backend for that CLI was never built, the key is
 * missing, the endpoint is unreachable. A single 「测试失败」 sends a person
 * looking in the wrong place three times out of four.
 *
 * Every check reports `skipped` as its own outcome, never as a pass. A check
 * that could not run and a check that passed look identical in a green tick,
 * and only one of them is evidence.
 */

/**
 * What one check concluded.
 *
 * `skipped` and `unknown` are different answers and were briefly the same
 * one, which is how a fully configured subscription agent came back as
 * ⚠️「有检查没跑成」 with every applicable check green:
 *
 *   skipped — there was nothing to check. A subscription seat needs no key; a
 *             connection with no endpoint uses the backend's default. That is
 *             a COMPLETE answer, not a gap.
 *   unknown — we wanted to check and could not. That is missing evidence, and
 *             it must not read as a pass.
 */
export type CheckOutcome = "ok" | "fail" | "skipped" | "unknown";

export interface CheckResult {
  readonly name: string;
  readonly outcome: CheckOutcome;
  readonly detail: string;
}

export interface AgentCheckReport {
  readonly templateId: string;
  readonly displayName: string;
  readonly checks: readonly CheckResult[];
}

/**
 * A successful seat request verifies reachability even when the separate HEAD probe failed.
 *
 * 取自 2.x 工作区里尚未提交的改动（8dcb903 之后）。
 */
export function reconcileReachability(reachability: CheckResult, probe: CheckResult): CheckResult {
  if (reachability.outcome !== "fail" || probe.outcome !== "ok") return reachability;
  return {
    ...reachability,
    outcome: "ok",
    detail: `席位真实调用已成功，后端连接可用。独立 HEAD 探测未完成：${reachability.detail}`,
  };
}

/**
 * The overall reading of a report.
 *
 * `fail` if anything failed. `incomplete` while any check could not RUN —
 * reporting a partly-run test as a pass is how a person concludes an agent
 * works when barely anything was actually checked.
 *
 * A `skipped` check does NOT make a report incomplete. It is an answer:
 * there was nothing there to check. Treating it as a gap made a correctly
 * configured subscription agent — key not needed, endpoint not needed, and
 * the real probe green — announce itself as 「有检查没跑成」.
 */
export function overallOf(report: AgentCheckReport): "ok" | "fail" | "incomplete" {
  // Nothing at all is not a pass: no evidence was gathered either way.
  if (report.checks.length === 0) return "incomplete";
  if (report.checks.some((check) => check.outcome === "fail")) return "fail";
  if (report.checks.some((check) => check.outcome === "unknown")) return "incomplete";
  return "ok";
}
