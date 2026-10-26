// 移植自 Squad 2.x packages/console/src/agenda-verdict.ts @ 8dcb903
/**
 * agenda-verdict.ts — what a host may change on the way to confirming.
 *
 * The rule 1.x drew and 2.0 had let slip: a confirmation confirms a PROPOSAL.
 * `resolveAgenda` used to read `request.agenda ?? team.draft`, so a client
 * could post an agenda nobody had drafted and the team would run it — which
 * makes 「秘书提议、主持人确认」 a description of the happy path rather than a
 * rule.
 *
 * What the host MAY do is edit: retitle a phase, rewrite an instruction,
 * reassign a task, drop a phase. 1.x locked scope/objective/completion
 * against edits because its IR carried a participant snapshot and a goal that
 * a text box had no business rewriting; 2.0's spec carries neither, so there
 * is less to protect and the check is correspondingly smaller — a standing
 * draft, and something left to run.
 */
import type { AgendaSpec } from "../../shared/index.ts";

export interface EditVerdict {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * Whether this confirmation may proceed.
 *
 * @param standing - the draft the team is holding, if any.
 * @param edited - what the host is confirming instead, if they changed it.
 */
export function agendaEditIsLegal(standing: AgendaSpec | undefined, edited: AgendaSpec | undefined): EditVerdict {
  if (standing === undefined) return { ok: false, detail: "没有待确认的议程。" };
  const held = edited ?? standing;
  if (held.phases.length === 0) {
    // An empty agenda runs nothing and still marks the team as running one.
    return { ok: false, detail: "一个阶段都没留下。要取消就按丢弃。" };
  }
  return { ok: true };
}
