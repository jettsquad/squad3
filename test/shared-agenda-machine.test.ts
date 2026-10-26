// 移植自 Squad 2.x packages/shared/test/agenda-machine.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import {
  checkAgendaAgainstRoster,
  needsOf,
  nodeIdOf,
  type AgendaPhase,
  type AgendaSpec,
} from "../src/shared/agenda.ts";
import {
  afterAttempt,
  applyDecision,
  doneAfterAttempt,
  isTransientFailure,
  withTransientRetry,
  initialNodes,
  nodeOf,
  parseSeatReport,
  passedTitles,
  phaseLedger,
  retryFeedback,
  rewindTo,
  runnable,
  settle,
  standing,
  tally,
  type ExitCheckResult,
  type NodeMap,
} from "../src/shared/agenda-machine.ts";

const phase = (title: string, extra: Partial<AgendaPhase> = {}): AgendaPhase => ({
  title,
  contextMode: "cumulative",
  tasks: [{ seatId: "a", instruction: `做 ${title}` }],
  ...extra,
});
const checked = (title: string, extra: Partial<AgendaPhase> = {}): AgendaPhase =>
  phase(title, { check: { command: `test -f ${title}` }, ...extra });
const check = (exitCode: number | null, tail = "", timedOut = false): ExitCheckResult => ({
  exitCode,
  tail,
  at: 1,
  ...(timedOut ? { timedOut: true } : {}),
});
const mark = (nodes: NodeMap, id: string, state: NodeMap[string]["state"]): NodeMap => ({
  ...nodes,
  [id]: { ...nodeOf(nodes, id), state },
});

// 2026-10-10 夜里那份议程的形状：七个阶段，每个只依赖前一个。
const chain: AgendaSpec = { phases: ["T0", "T1", "T2", "T3"].map((title) => checked(title)) };

describe("节点与依赖", () => {
  it("没写 id 就按位置叫 p1、p2；没写 needs 就依赖前一个", () => {
    expect(chain.phases.map((one, index) => nodeIdOf(one, index))).toEqual(["p1", "p2", "p3", "p4"]);
    expect(needsOf(chain, 0)).toEqual([]);
    expect(needsOf(chain, 2)).toEqual(["p2"]);
  });

  it("写了 needs 就以它为准，哪怕是空的", () => {
    const agenda: AgendaSpec = {
      phases: [
        phase("后端", { id: "be" }),
        phase("iOS", { id: "ios", needs: [] }),
        phase("联调", { needs: ["be", "ios"] }),
      ],
    };
    expect(needsOf(agenda, 1)).toEqual([]);
    expect(needsOf(agenda, 2)).toEqual(["be", "ios"]);
  });

  it("needs 只能指向写在前面的阶段，节点名不能重复", () => {
    const agenda: AgendaSpec = {
      phases: [phase("甲", { id: "x", needs: ["y"] }), phase("乙", { id: "y" }), phase("丙", { id: "x" })],
    };
    const problems = checkAgendaAgainstRoster(agenda, ["a"]).map((one) => one.detail);
    expect(problems.some((detail) => detail.includes("「y」不是写在它前面的阶段"))).toBe(true);
    expect(problems.some((detail) => detail.includes("「x」和前面的阶段重了"))).toBe(true);
  });

  it("旧数据只有「已完成标题」时，读成这些节点已通过", () => {
    const nodes = initialNodes(chain, ["T0", "T1"]);
    expect(passedTitles(chain, nodes)).toEqual(["T0", "T1"]);
    expect(runnable(chain, nodes)).toEqual([2]);
  });
});

describe("下一步跑谁", () => {
  it("直线议程一次只有一个可跑的", () => {
    expect(runnable(chain, initialNodes(chain))).toEqual([0]);
  });

  it("前置没通过的节点不会被点到", () => {
    // 那天夜里 T1 没办成，T2 到 T6 却照样各被点了一次，每人回一句「不开工」。
    const nodes = mark(initialNodes(chain, ["T0"]), "p2", "deciding");
    expect(runnable(chain, nodes)).toEqual([]);
    expect(standing(chain, nodes)).toBe("deciding");
  });

  it("两个节点等的是同一个已通过的节点时，都可跑", () => {
    const agenda: AgendaSpec = {
      phases: [phase("基础", { id: "base" }), phase("后端", { needs: ["base"] }), phase("iOS", { needs: ["base"] })],
    };
    expect(runnable(agenda, initialNodes(agenda, ["基础"]))).toEqual([1, 2]);
  });

  it("放下一个节点，依赖它的全部跳过，不依赖它的照跑", () => {
    const agenda: AgendaSpec = {
      phases: [
        phase("后端", { id: "be" }),
        phase("接口联调", { id: "api", needs: ["be"] }),
        phase("发布", { needs: ["api"] }),
        phase("iOS", { id: "ios", needs: [] }),
      ],
    };
    const nodes = settle(agenda, mark(initialNodes(agenda), "be", "unresolved"));
    expect(nodes["api"]?.state).toBe("skipped");
    expect(nodes["p3"]?.state).toBe("skipped");
    // 说的是阶段的名字，不是节点编号——「它依赖的 p3」要人去数是第几个。
    expect(nodes["api"]?.why).toBe("它依赖的「后端」没有通过");
    expect(nodes["p3"]?.why).toBe("它依赖的「接口联调」没有通过");
    expect(runnable(agenda, nodes)).toEqual([3]);
  });

  it("障碍清掉之后，之前被跳过的节点活过来", () => {
    const skipped = settle(chain, mark(initialNodes(chain, ["T0"]), "p2", "unresolved"));
    expect(skipped["p3"]?.state).toBe("skipped");
    const revived = settle(chain, mark(skipped, "p2", "pending"));
    expect(revived["p3"]?.state).toBe("pending");
    expect(revived["p4"]?.state).toBe("pending");
  });

  it("全部通过才叫跑完；有放下的叫结束", () => {
    expect(standing(chain, initialNodes(chain, ["T0", "T1", "T2", "T3"]))).toBe("finished");
    const ended = settle(chain, mark(initialNodes(chain, ["T0"]), "p2", "unresolved"));
    expect(standing(chain, ended)).toBe("ended");
    expect(tally(chain, ended)).toMatchObject({ passed: 1, unresolved: 1, skipped: 2 });
  });
});

describe("一次尝试之后", () => {
  const node = checked("T1");

  it("检查通过就是通过", () => {
    expect(afterAttempt(node, 1, { check: check(0) })).toEqual({ kind: "pass" });
  });

  it("检查没过、次数没用完：重做", () => {
    expect(afterAttempt(node, 1, { check: check(1) })).toEqual({ kind: "retry" });
    expect(afterAttempt(node, 2, { check: check(1) })).toEqual({ kind: "retry" });
  });

  it("做满次数仍未通过：进决策点，并说清做了几次、检查怎么说", () => {
    const step = afterAttempt(node, 3, { check: check(2) });
    expect(step).toMatchObject({ kind: "decide", reason: "check-failed" });
    expect(step.kind === "decide" ? step.why : "").toMatch(/做了 3 次.*退出码 2/);
  });

  it("次数上限可以按节点改", () => {
    expect(afterAttempt(checked("T1", { maxAttempts: 1 }), 1, { check: check(1) }).kind).toBe("decide");
  });

  it("席位说「完成」而检查没过，以检查为准", () => {
    expect(afterAttempt(node, 1, { report: { kind: "done" }, check: check(1) })).toEqual({ kind: "retry" });
  });

  it("席位说被卡住：不原样重做三遍，直接进决策点", () => {
    // 郑那晚就是这样：问题在别人领地的脚本里，他重做多少遍都一样。
    const step = afterAttempt(node, 1, {
      report: { kind: "blocked", detail: "scripts/exit-check.sh 缺 DB_SEED_URL，是周的领地" },
      check: check(1),
    });
    expect(step).toMatchObject({ kind: "decide", reason: "blocked" });
    expect(step.kind === "decide" ? step.why : "").toContain("exit-check.sh");
  });

  it("席位在问主持人：进决策点，而不是点下一个人", () => {
    const step = afterAttempt(node, 1, { report: { kind: "needs-host", detail: "要我现在改脚本吗" }, check: check(1) });
    expect(step).toMatchObject({ kind: "decide", reason: "needs-host" });
  });

  it("没有出口检查的阶段，席位自己说没做成：进决策点，不算通过", () => {
    // 验收阶段就是这样：它的产出只有一个结论，没有命令可以替它量。
    const { check: _dropped, ...unchecked } = node;
    const step = afterAttempt(unchecked, 1, { report: { kind: "not-done", detail: "R3、R7 未满足" } });
    expect(step).toMatchObject({ kind: "decide", reason: "not-done" });
    expect(step.kind === "decide" ? step.why : "").toContain("R3、R7");
    // 没写结果行，或说完成：照旧算通过。
    expect(afterAttempt(unchecked, 1, {})).toEqual({ kind: "pass" });
    expect(afterAttempt(unchecked, 1, { report: { kind: "done" } })).toEqual({ kind: "pass" });
  });

  it("有出口检查时，席位说没做成：也进决策点，不原样重做", () => {
    // W1 报「单靠改标题做不成」时，照检查重做三遍只会得到三次同样的话。
    const step = afterAttempt(node, 1, { report: { kind: "not-done", detail: "x" }, check: check(1) });
    expect(step).toMatchObject({ kind: "decide", reason: "not-done" });
  });

  it("检查过了，但席位说没做成、被卡住或在问主持人：检查不能替它说做成了", () => {
    // 真实发生的：验收人报 25 条需求 23 条未满足，出口检查是「验收表里有『未满足』三个字」，阶段算通过。
    const notDone = afterAttempt(node, 1, { report: { kind: "not-done", detail: "23 条未满足" }, check: check(0) });
    expect(notDone).toMatchObject({ kind: "decide", reason: "not-done" });
    expect(notDone.kind === "decide" ? notDone.why : "").toContain("出口检查通过了，但");
    expect(afterAttempt(node, 1, { report: { kind: "blocked", detail: "x" }, check: check(0) }).kind).toBe("decide");
    expect(afterAttempt(node, 1, { report: { kind: "needs-host", detail: "x" }, check: check(0) }).kind).toBe("decide");
    // 说完成、或没写结果行：照旧以检查为准。
    expect(afterAttempt(node, 1, { report: { kind: "done" }, check: check(0) })).toEqual({ kind: "pass" });
    expect(afterAttempt(node, 1, { check: check(0) })).toEqual({ kind: "pass" });
  });

  it("席位技术性失败：进决策点，不跑检查也不重试", () => {
    const step = afterAttempt(node, 1, { seatFailed: { seat: "周一", why: "判定为卡死" } });
    expect(step).toMatchObject({ kind: "decide", reason: "seat-failed" });
  });

  it("超时和被信号中止都不算通过", () => {
    expect(afterAttempt(node, 1, { check: check(0, "", true) }).kind).toBe("retry");
    expect(afterAttempt(node, 1, { check: check(null) }).kind).toBe("retry");
  });

  it("没有检查的阶段：答了就算过，除非自己说没做成、被卡住或在问主持人", () => {
    const plain = phase("讨论");
    expect(afterAttempt(plain, 1, {})).toEqual({ kind: "pass" });
    expect(afterAttempt(plain, 1, { report: { kind: "not-done", detail: "x" } }).kind).toBe("decide");
    expect(afterAttempt(plain, 1, { report: { kind: "blocked", detail: "x" } }).kind).toBe("decide");
  });

  it("重做时把检查命令、结果和输出交回去，并说清是第几次", () => {
    const feedback = retryFeedback(node, check(1, "FAILED test_x.py::test_y"), 1);
    expect(feedback).toContain("第 2 / 3 次");
    expect(feedback).toContain("test -f T1");
    expect(feedback).toContain("退出码 1");
    expect(feedback).toContain("FAILED test_x.py::test_y");
    expect(retryFeedback(node, check(1, ""), 1)).toContain("（没有输出）");
  });
});

describe("席位自报", () => {
  it("读最后一行【结果】", () => {
    expect(parseSeatReport("做完了。\n【结果】完成")).toEqual({ kind: "done" });
    expect(parseSeatReport("【结果】未完成：迁移没写完")).toEqual({ kind: "not-done", detail: "迁移没写完" });
    expect(parseSeatReport("【结果】被卡住：exit-check.sh 是周的领地")).toEqual({
      kind: "blocked",
      detail: "exit-check.sh 是周的领地",
    });
    expect(parseSeatReport("**【结果】需要主持人: 要不要改脚本**")).toMatchObject({ kind: "needs-host" });
  });

  it("写了好几行时以最后一行为准", () => {
    expect(parseSeatReport("【结果】未完成：先试试\n后来修好了\n【结果】完成")).toEqual({ kind: "done" });
  });

  it("没写或写得认不出，就当没写", () => {
    expect(parseSeatReport("都弄好了")).toBeUndefined();
    expect(parseSeatReport("【结果】差不多吧")).toBeUndefined();
  });
});

describe("在决策点", () => {
  const stuck = mark(initialNodes(chain, ["T0"]), "p2", "deciding");

  it("重做：回到待跑，次数重新算，交代的话带到下一次", () => {
    const nodes = applyDecision(chain, stuck, "p2", { kind: "retry", instruction: " 先修脚本再提交 " });
    expect(nodes["p2"]).toMatchObject({ state: "pending", attempts: 0, detour: { instruction: "先修脚本再提交" } });
    expect(runnable(chain, nodes)).toEqual([1]);
  });

  it("重做而不交代：不带多余的话", () => {
    expect(applyDecision(chain, stuck, "p2", { kind: "retry" })["p2"]?.detour).toBeUndefined();
  });

  it("让别人清障：下一次只跑那个席位，之后还是这个节点的检查说了算", () => {
    const nodes = applyDecision(chain, stuck, "p2", {
      kind: "assign",
      seatId: "sakuragi",
      instruction: "修 exit-check.sh 三处",
    });
    expect(nodes["p2"]).toMatchObject({
      state: "pending",
      detour: { seatId: "sakuragi", instruction: "修 exit-check.sh 三处" },
    });
  });

  it("视为通过：后面的阶段可以跑了", () => {
    const nodes = applyDecision(chain, stuck, "p2", { kind: "pass" });
    expect(nodes["p2"]?.state).toBe("passed");
    expect(runnable(chain, nodes)).toEqual([2]);
  });

  it("放下：依赖它的都跳过，议程结束", () => {
    const nodes = applyDecision(chain, stuck, "p2", { kind: "abandon" });
    expect(nodes["p2"]?.state).toBe("unresolved");
    expect(standing(chain, nodes)).toBe("ended");
  });

  it("上一次检查的结果留着，决定之后还看得到", () => {
    const withCheck: NodeMap = { ...stuck, p2: { state: "deciding", attempts: 3, lastCheck: check(1, "boom") } };
    expect(applyDecision(chain, withCheck, "p2", { kind: "retry" })["p2"]?.lastCheck?.tail).toBe("boom");
  });

  it("每做一个决定计一次数，重做之后也不清零", () => {
    // attempts 在决定之后重新算，decisions 不会：它是代理不能绕着同一个节点
    // 无限决定下去的依据。
    const once = applyDecision(chain, stuck, "p2", { kind: "retry" });
    expect(once["p2"]).toMatchObject({ attempts: 0, decisions: 1 });
    const again = applyDecision(chain, { ...once, p2: { ...once["p2"]!, state: "deciding" } }, "p2", {
      kind: "assign",
      seatId: "x",
      instruction: "清障",
    });
    expect(again["p2"]?.decisions).toBe(2);
    const dropped = applyDecision(chain, { ...again, p2: { ...again["p2"]!, state: "deciding" } }, "p2", {
      kind: "abandon",
    });
    expect(dropped["p2"]).toMatchObject({ state: "unresolved", decisions: 3 });
  });

  it("不在等决定的节点不能被决定", () => {
    expect(() => applyDecision(chain, stuck, "p1", { kind: "pass" })).toThrow(/不需要决定/);
    expect(() => applyDecision(chain, stuck, "nope", { kind: "pass" })).toThrow(/没有节点/);
  });

  it("退回到某一阶段：它和它后面的都重新待跑，前面的不动", () => {
    const done = initialNodes(chain, ["T0", "T1", "T2", "T3"]);
    const nodes = rewindTo(chain, done, 1);
    expect(passedTitles(chain, nodes)).toEqual(["T0"]);
    expect(runnable(chain, nodes)).toEqual([1]);
  });
});

describe("重试从没做完的那条任务接着做", () => {
  it("没做完时，把这次完成的并进已完成的", () => {
    expect(doneAfterAttempt({ before: [0], completed: [1], allDone: false, helperRun: false })).toEqual([0, 1]);
    expect(doneAfterAttempt({ before: undefined, completed: [0], allDone: false, helperRun: false })).toEqual([0]);
  });

  it("全部做完就清空：出口检查没过不是哪一条任务的错，下次整段重来", () => {
    expect(doneAfterAttempt({ before: [0], completed: [1], allDone: true, helperRun: false })).toBeUndefined();
  });

  it("被点来清障碍的席位不在计划里，不改记录", () => {
    expect(doneAfterAttempt({ before: [0], completed: [0], allDone: true, helperRun: true })).toEqual([0]);
  });

  it("决定「重做」时保留已完成的，「点人」时清掉", () => {
    const agenda: AgendaSpec = { phases: [phase("甲")] };
    const id = nodeIdOf(agenda.phases[0]!, 0);
    const deciding: NodeMap = { [id]: { state: "deciding", attempts: 1, doneTasks: [0] } };
    expect(nodeOf(applyDecision(agenda, deciding, id, { kind: "retry", instruction: "接着做" }), id).doneTasks).toEqual(
      [0],
    );
    expect(
      nodeOf(applyDecision(agenda, deciding, id, { kind: "assign", seatId: "b", instruction: "清障" }), id).doneTasks,
    ).toBeUndefined();
  });
});

describe("瞬时错误由固定规则重试", () => {
  it("认得出网络和模型服务的瞬时错误", () => {
    // 吴那次的真实报错：被当成任务失败交给了 Lil X。
    expect(isTransientFailure("Reconnecting... 2/5 (workspace routing discovery failed)")).toBe(true);
    expect(isTransientFailure("failed to refresh available models: request timed out")).toBe(true);
    expect(isTransientFailure("error sending request for url (https://x)")).toBe(true);
    expect(isTransientFailure("API Error: 529 overloaded_error")).toBe(true);
    expect(isTransientFailure("HTTP 503")).toBe(true);
  });

  it("认不出的不算：任务本身的失败要交给人", () => {
    expect(isTransientFailure("没有这个文件：clients/web/package.json")).toBe(false);
    expect(isTransientFailure("席位上限已到")).toBe(false);
    expect(isTransientFailure("")).toBe(false);
  });

  const run = (results: string[]) => {
    let calls = 0;
    return {
      fn: async () => results[Math.min(calls++, results.length - 1)]!,
      calls: () => calls,
    };
  };
  const failure = (text: string): string | undefined => (text.startsWith("ERR") ? text : undefined);

  it("瞬时错误之后成功，就用成功的那次", async () => {
    const r = run(["ERR timed out", "好了"]);
    const waited: number[] = [];
    const out = await withTransientRetry(r.fn, failure, {
      delaysMs: [1, 2],
      sleep: async (ms) => void waited.push(ms),
    });
    expect(out).toBe("好了");
    expect(waited).toEqual([1]);
  });

  it("重试有上限，上限到了把最后的失败交出去", async () => {
    const r = run(["ERR timed out"]);
    const out = await withTransientRetry(r.fn, failure, { delaysMs: [1, 2], sleep: async () => undefined });
    expect(out).toBe("ERR timed out");
    expect(r.calls()).toBe(3);
  });

  it("不是瞬时错误就不重试", async () => {
    const r = run(["ERR 文件不存在"]);
    await withTransientRetry(r.fn, failure, { delaysMs: [1], sleep: async () => undefined });
    expect(r.calls()).toBe(1);
  });

  it("已经叫停就不再重试", async () => {
    const r = run(["ERR timed out"]);
    await withTransientRetry(r.fn, failure, { delaysMs: [1], sleep: async () => undefined, stopped: () => true });
    expect(r.calls()).toBe(1);
  });
});

describe("报告里每个阶段的通过靠什么", () => {
  const agenda: AgendaSpec = {
    phases: [checked("甲"), phase("乙"), checked("丙"), checked("丁")],
  };
  const ids = agenda.phases.map((p, i) => nodeIdOf(p, i));
  const nodes: NodeMap = {
    [ids[0]!]: { state: "passed", attempts: 2, lastCheck: check(0) },
    [ids[1]!]: { state: "passed", attempts: 1 },
    [ids[2]!]: { state: "passed", attempts: 1, why: "主持人判为通过" },
    [ids[3]!]: { state: "unresolved", attempts: 3, why: "检查仍未通过" },
  };
  const ledger = phaseLedger(agenda, nodes);

  it("检查过了的才算验证过", () => {
    expect(ledger[0]).toMatchObject({ verified: true });
    expect(ledger[0]?.line).toContain("第 2 次");
  });

  it("没有检查的阶段，通过只代表席位答复了", () => {
    expect(ledger[1]).toMatchObject({ verified: false });
    expect(ledger[1]?.line).toContain("没有命令验证过");
  });

  it("主持人判过的、放下的，都不算验证过", () => {
    expect(ledger[2]).toMatchObject({ verified: false });
    expect(ledger[2]?.line).toContain("主持人判为通过");
    expect(ledger[3]).toMatchObject({ verified: false, state: "unresolved" });
  });
});
