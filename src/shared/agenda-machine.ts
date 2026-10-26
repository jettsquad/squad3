// 移植自 Squad 2.x packages/shared/src/agenda-machine.ts @ 8dcb903
/**
 * agenda-machine.ts — what an agenda does next.
 *
 * An agenda used to be a list walked once: each phase ran, its seats
 * answered, and it was done. "Done" meant "somebody replied". So a batch
 * whose exit script failed left five later phases to run anyway, each seat
 * answering 「前置提交不存在，不开工」, and the whole thing recorded as
 * finished — after which it sat for eight hours.
 *
 * Here it is a small state machine instead. A node passes when Squad's own
 * check says so, is retried with the check's output when it does not, and
 * reaches a DECISION POINT when retrying has stopped helping. Nodes that wait
 * on one that did not pass are never run at all.
 *
 * Pure, on purpose. Every rule below is a function of the agenda and the
 * nodes' recorded states; nothing here starts a seat, runs a command or reads
 * a clock. That is what lets the rules be tested one at a time — the loop
 * this replaces had no test at all, because it could only be exercised by
 * running real seats.
 */
import { needsOf, nodeIdOf, type AgendaPhase, type AgendaSpec } from "./agenda.ts";
import { isClassifierBlock } from "./seat-failure.ts";

/** Where a node stands, as it is written down. */
export type NodeState =
  /** Not run yet, or sent back to be run again. */
  | "pending"
  /** Its check passed — or it has none and its seats answered. */
  | "passed"
  /** The machine cannot go on by itself; somebody has to choose. */
  | "deciding"
  /** Given up on. */
  | "unresolved"
  /** Never run, because something it waits on did not pass. */
  | "skipped";

/** One run of a node's exit check. */
export interface ExitCheckResult {
  /** `null` when a signal ended it — which is not a pass. */
  readonly exitCode: number | null;
  /** The end of what it printed. */
  readonly tail: string;
  readonly at: number;
  readonly timedOut?: boolean | undefined;
}

/** A change of course for a node's next run, chosen at a decision point. */
export interface NodeDetour {
  /** Run THIS seat instead of the node's own; absent runs the node's own. */
  readonly seatId?: string | undefined;
  /** What to tell whoever runs. */
  readonly instruction: string;
}

export interface NodeRecord {
  readonly state: NodeState;
  /** Runs since the node was last sent back, this one included. */
  readonly attempts: number;
  readonly lastCheck?: ExitCheckResult | undefined;
  /** Why it is `deciding`, `unresolved` or `skipped`. */
  readonly why?: string | undefined;
  /** Consumed by the next run. */
  readonly detour?: NodeDetour | undefined;
  /**
   * Decisions taken at this node so far, by anyone.
   *
   * Kept across retries, unlike `attempts`: it is what stops a proxy from
   * deciding its way round the same node for ever.
   */
  readonly decisions?: number | undefined;
  /**
   * Which of the node's tasks (by position in its run plan) already finished
   * in the attempt that is being carried on.
   *
   * A retry used to start the phase over, so a seat that had delivered was
   * run again — and handed guidance written for whichever seat had failed.
   * Recorded per task, the way a durable-execution engine records each step,
   * so a retry resumes at the task that did not finish. Cleared when every
   * task has finished (a failed exit check is not any one task's fault) and
   * when the node is sent back to the start.
   */
  readonly doneTasks?: readonly number[] | undefined;
}

export type NodeMap = Readonly<Record<string, NodeRecord>>;

/** Attempts a node gets before it stops being retried. */
export const DEFAULT_MAX_ATTEMPTS = 3;

const FRESH: NodeRecord = { state: "pending", attempts: 0 };

/**
 * Every node of an agenda, not yet run.
 *
 * `donePhases` is how an agenda saved before nodes existed is read: its
 * finished phase titles become `passed`, which is what they were.
 */
export function initialNodes(agenda: AgendaSpec, donePhases: readonly string[] = []): NodeMap {
  const done = new Set(donePhases);
  return Object.fromEntries(
    agenda.phases.map((phase, index) => [
      nodeIdOf(phase, index),
      done.has(phase.title) ? { state: "passed" as const, attempts: 1 } : FRESH,
    ]),
  );
}

/** A node's record, whether or not anything was ever written for it. */
export const nodeOf = (nodes: NodeMap, id: string): NodeRecord => nodes[id] ?? FRESH;

/**
 * Carry "this did not pass" down to everything waiting on it.
 *
 * Run after any node is given up on. One pass in written order is enough,
 * because a node may only wait on nodes written before it.
 */
export function settle(agenda: AgendaSpec, nodes: NodeMap): NodeMap {
  const next: Record<string, NodeRecord> = { ...nodes };
  const titles = new Map(agenda.phases.map((phase, index) => [nodeIdOf(phase, index), phase.title] as const));
  for (const [index, phase] of agenda.phases.entries()) {
    const id = nodeIdOf(phase, index);
    const record = nodeOf(next, id);
    if (record.state !== "pending" && record.state !== "skipped") continue;
    const dead = needsOf(agenda, index).find((need) => {
      const state = nodeOf(next, need).state;
      return state === "unresolved" || state === "skipped";
    });
    // Named by title: the id is `p3` unless somebody chose one, and 「它依赖
    // 的 p3」 sends the reader off to count phases.
    if (dead !== undefined) {
      next[id] = { ...record, state: "skipped", why: `它依赖的「${titles.get(dead) ?? dead}」没有通过` };
    }
    // A node skipped earlier whose obstacle has since been cleared — the host
    // sent the blocking node back — is live again.
    else if (record.state === "skipped") next[id] = { state: "pending", attempts: 0 };
  }
  return next;
}

/**
 * The nodes that could run now, in written order.
 *
 * More than one can come back: two nodes that wait on the same finished node
 * are both ready. The table runs the first and asks again, which keeps a
 * single working tree from being written by two seats at once; nothing here
 * would need to change for it to run several.
 */
export function runnable(agenda: AgendaSpec, nodes: NodeMap): readonly number[] {
  const ready: number[] = [];
  for (const [index, phase] of agenda.phases.entries()) {
    if (nodeOf(nodes, nodeIdOf(phase, index)).state !== "pending") continue;
    if (needsOf(agenda, index).every((need) => nodeOf(nodes, need).state === "passed")) ready.push(index);
  }
  return ready;
}

/** Where the whole agenda stands. */
export type Standing =
  /** Something can run. */
  | "runnable"
  /** Nothing can run until a decision is made. */
  | "deciding"
  /** Every node passed. */
  | "finished"
  /** Nothing left to run, and not everything passed. */
  | "ended";

export function standing(agenda: AgendaSpec, nodes: NodeMap): Standing {
  if (runnable(agenda, nodes).length > 0) return "runnable";
  const states = agenda.phases.map((phase, index) => nodeOf(nodes, nodeIdOf(phase, index)).state);
  if (states.includes("deciding")) return "deciding";
  return states.every((state) => state === "passed") ? "finished" : "ended";
}

/** How many nodes stand in each state. */
export function tally(agenda: AgendaSpec, nodes: NodeMap): Readonly<Record<NodeState, number>> {
  const counts: Record<NodeState, number> = { pending: 0, passed: 0, deciding: 0, unresolved: 0, skipped: 0 };
  for (const [index, phase] of agenda.phases.entries()) counts[nodeOf(nodes, nodeIdOf(phase, index)).state] += 1;
  return counts;
}

/** Titles of the phases that passed, in written order — what `done` used to hold. */
export function passedTitles(agenda: AgendaSpec, nodes: NodeMap): readonly string[] {
  return agenda.phases
    .filter((phase, index) => nodeOf(nodes, nodeIdOf(phase, index)).state === "passed")
    .map((phase) => phase.title);
}

// ── What a seat says about its own turn ────────────────────────────────────

/** A seat's own account of how its turn went. */
export type SeatReport =
  | { readonly kind: "done" }
  | { readonly kind: "not-done"; readonly detail: string }
  | { readonly kind: "blocked"; readonly detail: string }
  | { readonly kind: "needs-host"; readonly detail: string };

/** Appended to a task whose phase has a check, so the seat ends on a line we can read. */
export const REPORT_FOOTER = [
  "这一步做完后，Squad 会自己运行出口检查。检查通过、并且你报的是完成，这一步才算通过；检查没过会让你重做。没做成、被卡住或要问人，就照实写，不要因为检查可能会过就写完成：你写了未完成，后面的任务会停下来等决定，而不是在缺东西的基础上接着做。",
  "答复的最后单独一行，四选一，原样使用这个前缀：",
  "【结果】完成",
  "【结果】未完成：<原因>",
  "【结果】被卡住：<卡在谁的什么东西上>",
  "【结果】需要主持人：<具体问题>",
].join("\n");

/**
 * The same line, asked of a phase that has no exit check.
 *
 * There the line is not a courtesy beside a measurement — it is the only
 * thing that can say the phase did not deliver. A verifier that found
 * requirements unmet has nothing else to say it with, so it has to be asked.
 */
export const REPORT_FOOTER_UNCHECKED = [
  "这一步没有出口检查，它算不算做成，只看你最后这一行，请照实写：没做成就写未完成，不要因为「我已经答复了」就写完成。",
  "答复的最后单独一行，四选一，原样使用这个前缀：",
  "【结果】完成",
  "【结果】未完成：<原因>",
  "【结果】被卡住：<卡在谁的什么东西上>",
  "【结果】需要主持人：<具体问题>",
].join("\n");

/**
 * Read the seat's last 【结果】 line.
 *
 * Used to avoid pointless work, never to decide a pass: a seat that says it
 * is blocked on somebody else's file gains nothing from being run twice more
 * unchanged. A reply without the line is simply a reply without it.
 */
export function parseSeatReport(text: string): SeatReport | undefined {
  const lines = text.split("\n").filter((line) => /【结果】/.test(line));
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const said = last.slice(last.indexOf("【结果】") + "【结果】".length).trim();
  const detail = said.replace(/^[^:：]*[:：]\s*/, "").trim();
  if (/^被卡住/.test(said)) return { kind: "blocked", detail };
  if (/^需要主持人/.test(said)) return { kind: "needs-host", detail };
  if (/^未完成/.test(said)) return { kind: "not-done", detail };
  if (/^完成/.test(said)) return { kind: "done" };
  return undefined;
}

// ── After one attempt ──────────────────────────────────────────────────────

/** What one run of a node came to. */
export interface AttemptOutcome {
  /** A seat that crashed, was cancelled as wedged, or was stopped. */
  readonly seatFailed?: { readonly seat: string; readonly why: string } | undefined;
  /** The last seat's own account, when it gave one. */
  readonly report?: SeatReport | undefined;
  /** Absent when the phase has no check, or a seat failed before it could run. */
  readonly check?: ExitCheckResult | undefined;
}

/** Why the machine stopped at a node. */
export type DecisionReason = "seat-failed" | "blocked" | "needs-host" | "not-done" | "check-failed";

export type Step =
  | { readonly kind: "pass" }
  | { readonly kind: "retry" }
  | { readonly kind: "decide"; readonly reason: DecisionReason; readonly why: string };

const passes = (check: ExitCheckResult): boolean => check.exitCode === 0 && check.timedOut !== true;

/**
 * What follows one run of a node.
 *
 * @param attempts runs so far since the node was last sent back, THIS one included.
 */
export function afterAttempt(phase: AgendaPhase, attempts: number, outcome: AttemptOutcome): Step {
  if (outcome.seatFailed !== undefined) {
    return {
      kind: "decide",
      reason: "seat-failed",
      why: `${outcome.seatFailed.seat} 没有完成：${outcome.seatFailed.why}${
        isClassifierBlock(outcome.seatFailed.why)
          ? "（模型服务的安全分类器拦下了这个席位的输出，不是网络问题；把同样的任务原样再做一遍多半还会被拦）"
          : ""
      }`,
    };
  }
  // What the seat says about its own work is heard BEFORE the check.
  //
  // It used to be the other way round — a passing check was a pass whatever
  // the seat said — on the reasoning that the check is the measurement and
  // the seat only an opinion. That holds only while the check measures the
  // work. An agenda then ended "6 / 6 passed" with its verifier reporting 23
  // of 25 requirements unmet, because the check was 「验收表里有『未满足』
  // 三个字」. So a check can refuse a phase; it cannot overrule the seat that
  // did the work saying it is not done. Somebody has to decide that.
  const report = outcome.report;
  const checked = outcome.check === undefined ? "" : passes(outcome.check) ? "出口检查通过了，但" : "";
  if (report?.kind === "blocked") {
    return { kind: "decide", reason: "blocked", why: `${checked}席位说被卡住：${report.detail}` };
  }
  if (report?.kind === "needs-host") {
    return { kind: "decide", reason: "needs-host", why: `${checked}席位在问主持人：${report.detail}` };
  }
  if (report?.kind === "not-done") {
    return { kind: "decide", reason: "not-done", why: `${checked}席位说没有做成：${report.detail}` };
  }
  // No check: the seats answered, did not say otherwise, and nothing can say more.
  if (outcome.check === undefined || passes(outcome.check)) return { kind: "pass" };

  const limit = phase.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (attempts < limit) return { kind: "retry" };
  return {
    kind: "decide",
    reason: "check-failed",
    why: `做了 ${attempts} 次，出口检查仍未通过（${describeCheck(outcome.check)}）`,
  };
}

/**
 * Which tasks of a node count as finished after one run of it.
 *
 * Everything done so far plus what this run finished — or nothing, once the
 * whole plan has finished, because from then on a retry is about the exit
 * check and every task goes again. A helper sent in to clear an obstacle runs
 * outside the plan and leaves the record as it was.
 */
export function doneAfterAttempt(input: {
  readonly before: readonly number[] | undefined;
  readonly completed: readonly number[];
  readonly allDone: boolean;
  readonly helperRun: boolean;
}): readonly number[] | undefined {
  if (input.helperRun) return input.before;
  if (input.allDone) return undefined;
  return [...new Set([...(input.before ?? []), ...input.completed])].sort((a, b) => a - b);
}

// ── A seat that failed for a reason that will pass ─────────────────────────

/**
 * Rounds a seat is run again on its own after a transient failure, before
 * anybody is asked what to do about it.
 */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [3_000, 15_000];

const TRANSIENT_FAILURE =
  /Reconnecting|routing discovery failed|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network (?:error|is unreachable)|error sending request|rate.?limit|overloaded|\b(?:429|502|503|504)\b|temporarily unavailable/i;

/**
 * Whether a failed seat's message names a failure that running it again
 * cures: the network, a model service that timed out or is busy.
 *
 * A fixed rule rather than a judgement. A model asked whether to retry spent
 * a decision, and in one agenda sent the retry to the wrong seat.
 */
export function isTransientFailure(text: string): boolean {
  // A refusal by the service's safety classifier is not a hiccup: the same
  // job sent again meets the same refusal, so it is never run again here.
  if (isClassifierBlock(text)) return false;
  return TRANSIENT_FAILURE.test(text);
}

/**
 * Run something, and again after each delay while it fails for a transient
 * reason. Returns the last result.
 *
 * `sleep` is injected so a test does not wait, and a stop cuts the waiting
 * short.
 */
export async function withTransientRetry<T>(
  run: () => Promise<T>,
  failure: (result: T) => string | undefined,
  options: {
    readonly delaysMs?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
    readonly stopped?: () => boolean;
    readonly onRetry?: (why: string, attempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  const delays = options.delaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let result = await run();
  for (const [index, delay] of delays.entries()) {
    const why = failure(result);
    if (why === undefined || !isTransientFailure(why) || options.stopped?.() === true) break;
    options.onRetry?.(why, index + 1, delay);
    await sleep(delay);
    if (options.stopped?.() === true) break;
    result = await run();
  }
  return result;
}

/** How one phase ended, for the report the host reads. */
export interface PhaseLedgerEntry {
  readonly title: string;
  readonly state: NodeState;
  /** Passed with a check that ran and exited 0. */
  readonly verified: boolean;
  readonly line: string;
}

/**
 * What stands behind each phase's pass.
 *
 * The report used to count passes, and a pass could mean three different
 * things: a command checked the delivery, the seats merely answered because
 * the phase had no check, or the host counted it through. "6 of 6 passed"
 * said none of that, and a reader took it for the first.
 */
export function phaseLedger(agenda: AgendaSpec, nodes: NodeMap): readonly PhaseLedgerEntry[] {
  return agenda.phases.map((phase, index) => {
    const node = nodeOf(nodes, nodeIdOf(phase, index));
    const base = { title: phase.title, state: node.state };
    if (node.state !== "passed") {
      const word = { pending: "没有跑到", deciding: "停在决策点", unresolved: "放下", skipped: "跳过" }[node.state];
      return { ...base, verified: false, line: `${word}${node.why === undefined ? "" : `：${node.why}`}` };
    }
    if (node.why === "主持人判为通过") {
      return { ...base, verified: false, line: "主持人判为通过，没有经过出口检查" };
    }
    if (phase.check === undefined) {
      return { ...base, verified: false, line: "没有出口检查：通过只表示席位答复了，没有命令验证过交付" };
    }
    const last = node.lastCheck;
    if (last === undefined || last.exitCode !== 0) {
      return { ...base, verified: false, line: `有出口检查，但没有留下通过的记录：${phase.check.command}` };
    }
    return { ...base, verified: true, line: `出口检查通过（第 ${node.attempts} 次）：${phase.check.command}` };
  });
}

/** A check's result in a few words. */
export function describeCheck(check: ExitCheckResult): string {
  if (check.timedOut === true) return "超时";
  return check.exitCode === null ? "被信号中止" : `退出码 ${check.exitCode}`;
}

/** What a seat is told when it is sent back to try again. */
export function retryFeedback(phase: AgendaPhase, check: ExitCheckResult, attempt: number): string {
  const limit = phase.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  return [
    `【出口检查未通过，这是第 ${attempt + 1} / ${limit} 次】`,
    `Squad 刚才运行了这一阶段的出口检查：${phase.check?.command ?? ""}`,
    `结果：${describeCheck(check)}。输出的最后一段：`,
    check.tail.trim() === "" ? "（没有输出）" : check.tail.trim(),
    "请针对这个结果把事情做完。如果问题不在你能改的范围内，照实用「被卡住」报告，不要原样重做。",
  ].join("\n");
}

// ── At a decision point ────────────────────────────────────────────────────

/** What can be chosen for a node that is `deciding`. */
export type Decision =
  /** Run the node again, optionally with guidance. A fresh set of attempts. */
  | { readonly kind: "retry"; readonly instruction?: string | undefined }
  /** Have one seat clear the obstacle; the node's check then says whether it worked. */
  | { readonly kind: "assign"; readonly seatId: string; readonly instruction: string }
  /** Count it as passed without the check. The host's alone to choose. */
  | { readonly kind: "pass" }
  /** Give up on it. Whatever waits on it is skipped. */
  | { readonly kind: "abandon"; readonly why?: string | undefined };

/** Apply a decision to a node. Throws when the node is not waiting for one. */
export function applyDecision(agenda: AgendaSpec, nodes: NodeMap, id: string, decision: Decision): NodeMap {
  const record = nodes[id];
  if (record === undefined) throw new Error(`议程里没有节点「${id}」。`);
  if (record.state !== "deciding") throw new Error(`节点「${id}」现在不需要决定。`);
  const kept = {
    ...(record.lastCheck === undefined ? {} : { lastCheck: record.lastCheck }),
    decisions: (record.decisions ?? 0) + 1,
  };
  let next: NodeRecord;
  if (decision.kind === "pass") next = { ...kept, state: "passed", attempts: record.attempts, why: "主持人判为通过" };
  else if (decision.kind === "abandon") {
    next = { ...kept, state: "unresolved", attempts: record.attempts, why: decision.why ?? record.why };
  } else if (decision.kind === "assign") {
    next = {
      ...kept,
      state: "pending",
      attempts: 0,
      detour: { seatId: decision.seatId, instruction: decision.instruction },
    };
  } else {
    const said = decision.instruction?.trim() ?? "";
    next = {
      ...kept,
      state: "pending",
      attempts: 0,
      // What already finished stays finished: the retry resumes where it stopped.
      ...(record.doneTasks === undefined ? {} : { doneTasks: record.doneTasks }),
      ...(said === "" ? {} : { detour: { instruction: said } }),
    };
  }
  return settle(agenda, { ...nodes, [id]: next });
}

/**
 * Put the agenda back to before one phase, so it and everything after it
 * run again.
 */
export function rewindTo(agenda: AgendaSpec, nodes: NodeMap, phaseIndex: number): NodeMap {
  const next: Record<string, NodeRecord> = { ...nodes };
  for (const [index, phase] of agenda.phases.entries()) {
    if (index >= phaseIndex) next[nodeIdOf(phase, index)] = FRESH;
  }
  return next;
}

// ── A proxy at the decision point ──────────────────────────────────────────

/** Decisions a proxy may take at one node before the node is put down. */
export const PROXY_DECISION_CAP = 3;

/** Everything a proxy is shown when the agenda cannot go on by itself. */
export interface DecisionPoint {
  readonly nodeId: string;
  readonly phase: AgendaPhase;
  /** Why the machine stopped, or that a phase asked for the host. */
  readonly reason: DecisionReason | "awaiting-host";
  readonly why: string;
  readonly attempts: number;
  /** Decisions already taken here, this one not included. */
  readonly decisions: number;
  readonly lastCheck?: ExitCheckResult | undefined;
  /** What the last seat to speak in this node said. */
  readonly lastReply?: { readonly seat: string; readonly text: string } | undefined;
  readonly agenda: AgendaSpec;
  readonly nodes: NodeMap;
  readonly seats: readonly { readonly seatId: string; readonly displayName: string; readonly role: string }[];
  readonly projectFolder: string;
  /**
   * Present on the second call for one decision: the proxy proposed
   * something, the seats concerned answered, and now it has to settle.
   */
  readonly discussion?:
    | { readonly proposal: string; readonly replies: readonly { readonly seat: string; readonly text: string }[] }
    | undefined;
}

/**
 * What a proxy may choose.
 *
 * There is no "ask the host": the proxy is there because the host is not.
 * There is no "pass" either — counting a node as passed without its check is
 * the host's alone, or the proxy would be marking its own work.
 */
export type ProxyDecision =
  /** Same seats again, told what to do differently. */
  | { readonly kind: "retry"; readonly instruction: string; readonly say: string }
  /** One seat clears the obstacle; the node's own check then says whether it worked. */
  | { readonly kind: "assign"; readonly seatId: string; readonly instruction: string; readonly say: string }
  /** Answer what a seat asked the host. */
  | { readonly kind: "answer"; readonly text: string }
  /** Put a proposed way out to the seats it concerns, for one round, before settling. */
  | { readonly kind: "discuss"; readonly seatIds: readonly string[]; readonly proposal: string }
  /** Put the node down. Whatever waits on it is skipped; the rest carries on. */
  | { readonly kind: "give-up"; readonly why: string };

/** One decision a proxy took, as it is kept for the report. */
export interface ProxyDecisionEntry {
  readonly at: number;
  readonly nodeId: string;
  readonly title: string;
  readonly problem: string;
  readonly action: ProxyDecision["kind"] | "cap-reached";
  readonly detail: string;
  readonly discussion?: DecisionPoint["discussion"];
}
