/**
 * agenda-runner.ts — running a confirmed agenda, node by node.
 *
 * 移植自 Squad 2.x packages/table/src/service.ts 的 runAgenda / runPhaseOnce @ 8dcb903
 * 改动：从服务类里拆出来，经一个窄接口（`AgendaPort`）做一切 I/O——席位一轮、窗口、检查、
 * 写文件、存节点、写记录——所以能用假席位测。逻辑照搬：一次跑一个可跑节点、出口检查由
 * Squad 跑、席位自报【结果】先于检查被听、清障之后本阶段自己的席位再接着做、瞬时错误按
 * 固定规则自动重试、决策点停下等人（或交给 Lil X，阶段 4b）。
 *
 * The whole agenda is one stretch of work: the caller holds the team busy for
 * its duration, so an automatic fold cannot record a boundary in the middle of
 * something the host asked for as a unit.
 */
import {
  afterAttempt,
  artifactText,
  describeCheck,
  doneAfterAttempt,
  nodeIdOf,
  nodeOf,
  parseSeatReport,
  REPORT_FOOTER,
  REPORT_FOOTER_UNCHECKED,
  resolveArtifactPath,
  retryFeedback,
  runnable,
  seatFailureReason,
  settle,
  standing,
  tally,
  touchedSince,
  withTransientRetry,
  type AgendaPhase,
  type AgendaSpec,
  type DecisionReason,
  type ExitCheckResult,
  type FileStamp,
  type NodeDetour,
  type NodeMap,
  type SeatReport,
  type SeatSpec,
  type Step,
} from "../../shared/index.ts";
import { planPhase, pausesAfter, type PlannedRun } from "./agenda.ts";
import { firstLine } from "./commands.ts";

/** One seat's turn inside an agenda, as the runner sees it. */
export interface AgendaTurnResult {
  readonly text: string;
  readonly failed: boolean;
  readonly cancelled: boolean;
}

/** Where a decision is needed, for whoever takes it (the host, or Lil X in 4b). */
export interface DecisionAt {
  readonly phase: AgendaPhase;
  readonly nodeId: string;
  readonly reason: DecisionReason;
  readonly why: string;
  readonly lastReply: { readonly seat: string; readonly text: string } | undefined;
}

export interface AgendaPort {
  /** Aborted when the host stops the agenda (or Squad quits). */
  readonly signal: AbortSignal;
  /** The live roster: a member added mid-agenda is usable. */
  seats(): readonly SeatSpec[];
  /** A line in the record from the program itself. */
  note(text: string): void;
  /**
   * One seat, one task. `recorded` is what the record shows as the host's line;
   * `instruction` is what the seat is asked. `window` is a snapshot taken at
   * phase start, or absent for a fresh one. Never throws: a failure is a failed result.
   */
  turn(
    seat: SeatSpec,
    recorded: string,
    instruction: string,
    window: readonly string[] | undefined,
  ): Promise<AgendaTurnResult>;
  /** The window this seat would be handed now, for a phase-start snapshot. */
  snapshot(seat: SeatSpec): readonly string[];
  check(check: NonNullable<AgendaPhase["check"]>): Promise<ExitCheckResult>;
  stamp(relative: string): Promise<FileStamp | undefined>;
  writeArtifact(relative: string, text: string): Promise<void>;
  /** Persist where every node stands. */
  saveNodes(nodes: NodeMap): void;
  progress(progress: { readonly phase: string; readonly phaseIndex: number; readonly phaseCount: number }): void;
  /** A phase finished: its title and tasks, for a hand-off if the agenda is stopped. */
  completedTask(instruction: string): void;
  completedPhase(title: string): void;
  /**
   * Lil X at a decision point (4b). Returns the nodes after its decision, or
   * `undefined` to stop for the host.
   */
  decide?: ((at: DecisionAt, nodes: NodeMap) => Promise<NodeMap | undefined>) | undefined;
  /** Lil X answering a phase that asked for the host (4b). True carries on. */
  answer?: ((phase: AgendaPhase, nodeId: string, nodes: NodeMap) => Promise<boolean>) | undefined;
}

export interface AgendaRunOutcome {
  readonly nodes: NodeMap;
  readonly artifacts: readonly string[];
  readonly pausedAfter?: string | undefined;
  readonly decidingAt?: { readonly phase: string; readonly nodeId: string; readonly why: string } | undefined;
}

interface Attempt {
  readonly failed: { readonly seat: string; readonly why: string } | undefined;
  /** Positions in the run plan that finished in THIS call. */
  readonly completed: readonly number[];
  /** Every task of the plan has now finished, here or earlier. */
  readonly allDone: boolean;
  readonly report: SeatReport | undefined;
  readonly last: { readonly seat: string; readonly text: string } | undefined;
}

/**
 * Run one node's tasks, once. It says only what happened — which seat did
 * not finish, and what the last seat reported about itself. Whether that
 * amounts to a pass is decided by `afterAttempt`.
 */
async function runPhaseOnce(
  port: AgendaPort,
  phase: AgendaPhase,
  guidance: NodeDetour | undefined,
  artifacts: string[],
  /** Positions in the run plan that already finished and are not run again. */
  finished: ReadonlySet<number>,
): Promise<Attempt> {
  let failed: Attempt["failed"];
  let report: SeatReport | undefined;
  let last: Attempt["last"];
  const completed: number[] = [];
  const own = planPhase(phase);
  // A detour naming a seat runs that seat alone, on the detour's own
  // instruction: it is there to clear an obstacle, not to do the node's work
  // over. Otherwise the node's own tasks run, with what was said about the
  // last attempt added underneath.
  const runs: readonly PlannedRun[] =
    guidance?.seatId === undefined
      ? own
      : [{ task: { seatId: guidance.seatId, instruction: guidance.instruction }, round: 1, window: "before-turn" }];
  const added = guidance !== undefined && guidance.seatId === undefined ? `\n\n${guidance.instruction}` : "";
  const footer = `\n\n${phase.check === undefined ? REPORT_FOOTER_UNCHECKED : REPORT_FOOTER}`;
  const resumable = guidance?.seatId === undefined;
  const skipped = (index: number): boolean => resumable && finished.has(index);

  // Taken once, before anything in the phase speaks: every `phase-start` run
  // is handed this same snapshot, so independence is a fact of what exists.
  // Only for the seats that will actually be handed it.
  const opening = new Map<string, readonly string[]>();
  for (const [index, run] of runs.entries()) {
    if (skipped(index) || run.window !== "phase-start" || opening.has(run.task.seatId)) continue;
    const seat = port.seats().find((candidate) => candidate.seatId === run.task.seatId);
    if (seat !== undefined) opening.set(seat.seatId, port.snapshot(seat));
  }

  for (const [index, run] of runs.entries()) {
    if (skipped(index)) {
      const name =
        port.seats().find((candidate) => candidate.seatId === run.task.seatId)?.displayName ?? run.task.seatId;
      port.note(`↷ 「${phase.title}」里 ${name} 的这条任务上一次已经完成，这次不重做。`);
      continue;
    }
    // Checked between runs, so a stop lands at a task boundary.
    if (port.signal.aborted) break;
    const seat = port.seats().find((candidate) => candidate.seatId === run.task.seatId);
    if (seat === undefined) {
      // Vetting refuses this before confirmation, so the roster changed under
      // a confirmed agenda. A task nobody ran and a seat with nothing to say
      // are the same silence, so it is a failure, not a skip.
      port.note(`⚠️ 议程点名了不在名册上的席位「${run.task.seatId}」，本条未执行。`);
      failed = { seat: run.task.seatId, why: "议程点名的席位不在名册上。" };
      break;
    }

    const path = resolveArtifactPath(
      run.task.artifactPath === undefined ? undefined : { path: run.task.artifactPath },
      { seatId: seat.seatId, phaseId: `${phase.title}-${run.round}` },
      phase.tasks.filter((candidate) => candidate.artifactPath === run.task.artifactPath).length,
    );
    // Looked at BEFORE the seat runs, to tell afterwards whether it wrote the file itself.
    const stampBefore = path === undefined ? undefined : await port.stamp(path);

    // A failure that running again cures (the network, a busy model service)
    // is cured here, by a fixed rule, before anyone is asked.
    const reply = await withTransientRetry(
      () =>
        port.turn(
          seat,
          `（${phase.title}）${run.task.instruction}${added}`,
          `${run.task.instruction}${added}${footer}`,
          run.window === "phase-start" ? (opening.get(seat.seatId) ?? []) : undefined,
        ),
      (result) => (result.failed ? result.text : undefined),
      {
        stopped: () => port.signal.aborted,
        onRetry: (why, attempt, delayMs) =>
          port.note(
            `⟳ ${seat.displayName} 遇到瞬时错误，${Math.round(delayMs / 1000)} 秒后自动重试（第 ${attempt} 次）：${firstLine(why)}`,
          ),
      },
    );
    last = { seat: seat.displayName, text: reply.text };
    const said = reply.failed ? undefined : parseSeatReport(reply.text);
    if (!reply.failed) {
      port.completedTask(run.task.instruction);
      report = said ?? report;
    }
    // A seat that did not finish stops the phase where it stands: what follows
    // was planned on the assumption that this was done.
    if (reply.failed && !port.signal.aborted) {
      failed = { seat: seat.displayName, why: seatFailureReason(reply.text) };
      break;
    }
    if (path !== undefined && !reply.failed) {
      // Not over a file the seat wrote itself: writing its completion note
      // over the chapter puts a 40-line report where the chapter was.
      if (touchedSince(stampBefore, await port.stamp(path))) {
        port.note(`↷ ${seat.displayName} 这一轮自己写了 ${path}，没有用他的回复覆盖它。`);
      } else {
        await port.writeArtifact(path, artifactText(reply.text));
      }
      artifacts.push(path);
    }
    // A seat that says its own task is not done stops the phase there too:
    // the tasks after it were planned on its result.
    if (said !== undefined && said.kind !== "done") break;
    completed.push(index);
  }
  const allDone =
    failed === undefined &&
    !port.signal.aborted &&
    runs.every((_, index) => skipped(index) || completed.includes(index));
  return { failed, completed, allDone, report, last };
}

/** Run until nothing can run, a decision is needed, a phase pauses for the host, or the agenda is stopped. */
export async function runAgendaNodes(port: AgendaPort, agenda: AgendaSpec, start: NodeMap): Promise<AgendaRunOutcome> {
  let nodes = start;
  const artifacts: string[] = [];
  let pausedAfter: string | undefined;
  let decidingAt: AgendaRunOutcome["decidingAt"];

  while (!port.signal.aborted) {
    nodes = settle(agenda, nodes);
    // The first of whatever can run; others take turns — one working tree
    // cannot be written by two seats at once.
    const phaseIndex = runnable(agenda, nodes)[0];
    const phase = phaseIndex === undefined ? undefined : agenda.phases[phaseIndex];
    if (phaseIndex === undefined || phase === undefined) break;
    const nodeId = nodeIdOf(phase, phaseIndex);
    port.progress({ phase: phase.title, phaseIndex: phaseIndex + 1, phaseCount: agenda.phases.length });

    let step: Step | undefined;
    let lastReply: Attempt["last"];
    // What the seats are told on top of their task: the check's output after
    // a failed attempt, or what was decided at a decision point.
    let guidance = nodeOf(nodes, nodeId).detour;
    while (!port.signal.aborted) {
      const finished = new Set(nodeOf(nodes, nodeId).doneTasks ?? []);
      const attempt = await runPhaseOnce(port, phase, guidance, artifacts, finished);
      if (port.signal.aborted) break;
      const helperRun = guidance?.seatId !== undefined;
      const doneTasks = doneAfterAttempt({
        before: nodeOf(nodes, nodeId).doneTasks,
        completed: attempt.completed,
        allDone: attempt.allDone,
        helperRun,
      });
      // A seat sent in to clear an obstacle has not done the phase's own work,
      // and a passing check has not proved it was done: the phase's own seats
      // go again from the first unfinished task, and only then is the check
      // run. Except when the check itself was the obstacle — then the helper's
      // work is measured by it.
      const cleared = attempt.report === undefined || attempt.report.kind === "done";
      const checkWasTheObstacle = phase.check !== undefined && nodeOf(nodes, nodeId).lastCheck !== undefined;
      if (guidance?.seatId !== undefined && attempt.failed === undefined && cleared && !checkWasTheObstacle) {
        const helper = port.seats().find((seat) => seat.seatId === guidance?.seatId)?.displayName ?? "被点到的席位";
        lastReply = attempt.last ?? lastReply;
        const { detour: _spent, ...kept } = nodeOf(nodes, nodeId);
        nodes = { ...nodes, [nodeId]: kept };
        port.saveNodes(nodes);
        guidance = {
          instruction: `${helper} 刚按安排处理了挡住这一阶段的问题。请接着做这一阶段还没做完的部分，以现在的实际情况为准，不要沿用上一次的结论。`,
        };
        continue;
      }
      // Not run when the seat itself says the work is not done: that goes to a
      // decision whatever the check would say, and some checks take minutes.
      const delivered = attempt.report === undefined || attempt.report.kind === "done";
      const check =
        attempt.failed === undefined && delivered && phase.check !== undefined
          ? await port.check(phase.check)
          : undefined;
      if (port.signal.aborted) break;
      const attempts = nodeOf(nodes, nodeId).attempts + 1;
      step = afterAttempt(phase, attempts, { seatFailed: attempt.failed, report: attempt.report, check });
      if (check !== undefined) {
        // In the discussion: it is the fact the next seat stands on.
        port.note(
          `${step.kind === "pass" ? "✅" : "❌"} 「${phase.title}」出口检查${step.kind === "pass" ? "通过" : "未通过"}` +
            `（${describeCheck(check)}，第 ${attempts} 次）：${phase.check?.command ?? ""}`,
        );
      }
      const before = nodeOf(nodes, nodeId);
      nodes = {
        ...nodes,
        [nodeId]: {
          state: step.kind === "pass" ? "passed" : step.kind === "decide" ? "deciding" : "pending",
          attempts,
          // The last check that RAN, even when this attempt did not run it: a seat
          // that answers a failed check with 「被卡住」 is talking about that check,
          // and dropping it showed 「还没跑过」 and hid the evidence from the
          // decision (2.x dropped it; seen in the 3 walkthrough).
          ...(check === undefined
            ? before.lastCheck === undefined
              ? {}
              : { lastCheck: before.lastCheck }
            : { lastCheck: check }),
          ...(step.kind === "decide" ? { why: step.why } : {}),
          ...(step.kind === "pass" || doneTasks === undefined ? {} : { doneTasks }),
          // Kept across attempts: it is what stops a proxy deciding its way
          // round the same node for ever.
          ...(before.decisions === undefined ? {} : { decisions: before.decisions }),
        },
      };
      lastReply = attempt.last ?? lastReply;
      port.saveNodes(nodes);
      if (step.kind !== "retry" || check === undefined) break;
      guidance = { instruction: retryFeedback(phase, check, attempts) };
    }
    if (port.signal.aborted || step === undefined) break;

    if (step.kind === "decide") {
      const decided =
        port.decide === undefined
          ? undefined
          : await port.decide({ phase, nodeId, reason: step.reason, why: step.why, lastReply }, nodes);
      if (port.signal.aborted) break;
      if (decided !== undefined) {
        nodes = decided;
        continue;
      }
      // Stops here even though another node might be runnable: work piling
      // up behind a choice nobody has made is how a plan drifts from what was
      // confirmed.
      decidingAt = { phase: phase.title, nodeId, why: step.why };
      break;
    }
    port.completedPhase(phase.title);
    if (pausesAfter(phase)) {
      const answered = port.answer === undefined ? false : await port.answer(phase, nodeId, nodes);
      if (port.signal.aborted) break;
      if (answered) continue;
      pausedAfter = phase.title;
      break;
    }
  }
  nodes = settle(agenda, nodes);
  port.saveNodes(nodes);
  return {
    nodes,
    artifacts,
    ...(pausedAfter === undefined ? {} : { pausedAfter }),
    ...(decidingAt === undefined ? {} : { decidingAt }),
  };
}

/** How an agenda run ended, in one sentence for the audit, and whether it is over. */
export function agendaEnding(
  agenda: AgendaSpec,
  outcome: AgendaRunOutcome,
  stopped: boolean,
): { readonly kind: "agenda-finished" | "agenda-stopped" | "agenda-paused"; readonly detail: string } {
  const stood = standing(agenda, outcome.nodes);
  const counts = tally(agenda, outcome.nodes);
  if (stopped) return { kind: "agenda-stopped", detail: `议程被叫停，已通过 ${counts.passed} 个阶段。` };
  if (outcome.decidingAt !== undefined) {
    return {
      kind: "agenda-paused",
      detail: `议程停在「${outcome.decidingAt.phase}」，需要决定：${unstopped(outcome.decidingAt.why)}。`,
    };
  }
  if (outcome.pausedAfter !== undefined) {
    return { kind: "agenda-paused", detail: `议程停在「${outcome.pausedAfter}」之后，等主持人。` };
  }
  if (stood === "finished") return { kind: "agenda-finished", detail: `议程跑完，${counts.passed} 个阶段全部通过。` };
  return {
    kind: "agenda-finished",
    detail: `议程结束：通过 ${counts.passed}，未解决 ${counts.unresolved}，因此跳过 ${counts.skipped}。`,
  };
}

export const unstopped = (text: string): string => text.trim().replace(/[。.]+$/, "");
