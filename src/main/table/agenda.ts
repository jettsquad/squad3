// 移植自 Squad 2.x packages/table/src/agenda.ts @ 8dcb903
/**
 * agenda.ts — expanding a confirmed agenda into the runs it means.
 *
 * A phase does not say "run these tasks"; it says "run these tasks, this many
 * times, each seeing this much". Getting that expansion wrong is quiet in
 * every direction — a phase that repeats once too few looks like a team that
 * converged, and a task handed the wrong snapshot looks like a member who
 * ignored what was said. So the expansion is pure and tested, and the
 * executor around it only does I/O.
 */
import type { AgendaPhase, AgendaSpec, AgendaTask } from "../../shared/index.ts";

/**
 * Which window a run is given.
 *
 * `phase-start` — the discussion as it stood when the phase opened, shared by
 * every run in the phase. `before-turn` — taken fresh, so it includes the
 * runs before it.
 */
export type WindowPolicy = "phase-start" | "before-turn";

export interface PlannedRun {
  readonly task: AgendaTask;
  /** 1-based; a phase that does not repeat has only round 1. */
  readonly round: number;
  readonly window: WindowPolicy;
}

/**
 * How many passes a phase makes.
 *
 * `after-bounded-rounds` without `maxRounds` is treated as one pass, not as
 * unbounded. The agenda is vetted before it gets here and that combination is
 * refused, so reaching this is already a bug — and the safe reading of a bug
 * about repetition is "repeat less", never "repeat forever".
 */
export const roundsOf = (phase: AgendaPhase): number =>
  phase.exit === "after-bounded-rounds" ? Math.max(1, phase.maxRounds ?? 1) : 1;

/**
 * The window a task gets, with the task's own cutoff overriding the phase.
 *
 * `independent` is a fact of topology, not a promise: every run in the phase
 * is handed the same snapshot, so there is no edge from one seat to another
 * for the assembler to carry along even if it wanted to.
 */
export const windowPolicyOf = (phase: AgendaPhase, task: AgendaTask): WindowPolicy => {
  if (task.publicContextCutoff === "phase-start") return "phase-start";
  if (task.publicContextCutoff === "immediately-before-turn") return "before-turn";
  return phase.contextMode === "independent" ? "phase-start" : "before-turn";
};

/** Expand one phase into the ordered runs it means. */
export function planPhase(phase: AgendaPhase): readonly PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (let round = 1; round <= roundsOf(phase); round++) {
    for (const task of phase.tasks) {
      runs.push({ task, round, window: windowPolicyOf(phase, task) });
    }
  }
  return runs;
}

/** Whether the agenda pauses for the host after this phase. */
export const pausesAfter = (phase: AgendaPhase): boolean => phase.exit === "wait-for-host";

/**
 * What an interrupted agenda still owes.
 *
 * The section of a hand-off that decides whether it is useful. A document
 * listing what was done but not what was left reads as complete to whoever
 * picks the work up, and starts them in the wrong place — so a phase the stop
 * cut through must contribute its unfinished tasks, not disappear because it
 * was "in progress".
 *
 * A phase counts as done only when every run in it finished. Half a phase in
 * the completed list would put its remaining tasks in neither column.
 */
export function outstandingWork(
  agenda: AgendaSpec,
  completedPhases: readonly string[],
  completedTasks: readonly string[],
): readonly string[] {
  const donePhases = new Set(completedPhases);
  const doneTasks = new Set(completedTasks);
  const remaining: string[] = [];
  for (const phase of agenda.phases) {
    if (donePhases.has(phase.title)) continue;
    const unfinished = phase.tasks.map((task) => task.instruction).filter((instruction) => !doneTasks.has(instruction));
    remaining.push(
      unfinished.length === 0 ? `阶段「${phase.title}」` : `阶段「${phase.title}」：${unfinished.join("；")}`,
    );
  }
  return remaining;
}
