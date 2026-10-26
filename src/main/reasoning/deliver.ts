// 移植自 Squad 2.x packages/reasoning/src/deliver.ts @ 8dcb903
/**
 * deliver.ts — choosing which criteria to surface, and how they read.
 *
 * The wording is AFTER THE FACT: 「这一步我按的是……」, not 「以下判据现在生效
 * 中」. The difference is not tone. A standard shown before the work reads as
 * a reminder of something the reader already knows, and gets skipped — the
 * host wrote these. Shown as an account of a decision already taken, it is
 * the one thing they cannot supply themselves: which of their own standards
 * was actually load-bearing here. The design says so in its own words —
 * 「系统不能只给结果。每次它应用一条判据，必须说出用了哪条、为什么」 — and
 * the reason given there is that a system which only hands over results makes
 * its user more dependent, while one that names the standard it used lets
 * them see patterns in their own judgement they had not noticed.
 *
 * Nothing at all when there is nothing to say. 「这次没有可用的判据」 is a
 * line about the machinery, printed into a discussion that was not asking.
 *
 * Two hard limits, and both are structural rather than advisory.
 *
 * At most THREE. A criteria library that grows without a delivery budget
 * ends up prefacing every decision with everything it has ever learned,
 * which is how a set of judgements becomes noise that gets skipped. The cap
 * is applied here, where the list is produced, not left to whoever renders
 * it.
 *
 * And nothing here formats anything for a discussion seat. Criteria go to
 * the host side and the secretary only — they shape how work is organised
 * and judged, never how a participant thinks. That separation is this
 * system's main defence against becoming an echo chamber, and it is enforced
 * by topology: these strings are returned to the caller and never handed to
 * the table, so there is no path along which they could reach a seat's
 * prompt. A rule someone has to keep obeying would not survive a year.
 */
import type { Criterion } from "./criterion.ts";
import type { Situation } from "../../shared/index.ts";

/** Hard budget per delivery. */
export const DELIVERY_LIMIT = 3;

/**
 * Coarse filter: could this criterion bear on this situation?
 *
 * COULD, not DOES. Features only have to overlap, not to be contained — and
 * that is a correction, made against evidence rather than taste.
 *
 * It was written as a conjunction first, matching how a criterion reads
 * (「特征 ⊇ {自动触发, 结果不可见}」). Then a criterion learned from
 * designing an auto-fold mechanism failed to fire on a phase labelled
 * "design an auto-fold mechanism": the distillation had filed it under
 * {automatic, invisible-result} and the secretary had labelled the phase
 * {automatic, changes-default}. Both labels are defensible. Two independent
 * model calls picking from a closed list with no shared anchor will disagree
 * like this, and no amount of prompt tuning on either side removes it.
 *
 * The asymmetry decides it. Over-fetching is recoverable — the selection step
 * reads the claim and the boundary and drops what does not apply, and a hard
 * cap of three stands behind that. Under-fetching is not: the criterion is
 * never seen by anything that could judge it, which is the design's own first
 * failure mode ("never recalled → the trigger is wrong"). A coarse filter
 * that demands exact agreement is not coarse.
 */
export function triggerMatches(criterion: Criterion, situation: Situation): boolean {
  if (criterion.status === "retired") return false;
  if (!criterion.trigger.action.includes(situation.action)) return false;
  const held = new Set(situation.features);
  // A trigger naming no features fires on the action alone — a deliberately
  // broad criterion, and the model still gets to drop it.
  if (criterion.trigger.features.length > 0 && !criterion.trigger.features.some((feature) => held.has(feature))) {
    return false;
  }
  const steps = criterion.trigger.step;
  if (steps !== undefined && steps.length > 0) {
    if (situation.step === undefined || !steps.includes(situation.step)) return false;
  }
  return true;
}

export function buildSelectionPrompt(situation: Situation, candidates: readonly Criterion[]): string {
  return [
    "你在帮一个人挑出「这次真正用得上」的判断标准。下面是按处境粗筛出来的候选。",
    `最多挑 ${DELIVERY_LIMIT} 条，**宁少勿多**——投多了会被整体跳过，等于一条都没投。`,
    "",
    "挑选时特别注意每条的「适用边界」：边界排除了当前处境的，不要选，哪怕主张听起来很对。",
    "边界正是从反例里长出来的，忽略它就是把判据当口号用。",
    "",
    "只回复一个 JSON 数组，元素是选中的 id，不要有别的文字。没有合适的就回复 []。",
    "",
    `当前处境：动作类型=${situation.action}，特征=${situation.features.join("、") || "（无）"}${
      situation.step === undefined ? "" : `，框架位置=${situation.step}`
    }`,
    "",
    "候选：",
    ...candidates.map(
      (c) =>
        `- id: ${c.id}\n  主张：${c.claim}${c.boundary === undefined ? "" : `\n  适用边界：${c.boundary}`}\n  证据条数：${c.evidence.length}`,
    ),
  ].join("\n");
}

/**
 * Read the selection back, keeping only ids that were actually offered.
 *
 * An id the model invented would be dropped by the lookup anyway; refusing
 * loudly instead means a selection prompt that has drifted out of sync with
 * the library shows up as an error rather than as a delivery that quietly
 * carries fewer criteria than it should.
 */
export function parseSelection(text: string, candidates: readonly Criterion[]): readonly Criterion[] {
  const trimmed = text.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("精选没有返回 JSON 数组。");
  const ids: unknown = JSON.parse(trimmed.slice(start, end + 1));
  if (!Array.isArray(ids)) throw new Error("精选返回的不是数组。");

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const chosen: Criterion[] = [];
  for (const entry of ids) {
    // A bare id, or an object carrying one. Both are unambiguous, and models
    // move between the two shapes freely — refusing the second would fail the
    // whole delivery and leave the host with nothing over a formatting
    // preference. Tolerance stops there: anything else is refused rather than
    // guessed at. Same bounded latitude `extractJson` gives prose around an
    // object.
    const id =
      typeof entry === "string"
        ? entry
        : typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string"
          ? (entry as { id: string }).id
          : undefined;
    if (id === undefined) throw new Error(`精选返回了读不出 id 的元素：${JSON.stringify(entry)}`);
    const found = byId.get(id);
    if (found === undefined) throw new Error(`精选挑了不在候选里的 ${id}。`);
    if (!chosen.includes(found)) chosen.push(found);
  }
  // Capped here as well as asked for in the prompt. A budget that depends on
  // a model honouring it is not a budget.
  return chosen.slice(0, DELIVERY_LIMIT);
}

/**
 * Render criteria for the system channel.
 *
 * Three things have to travel with every one of them:
 *
 *   that it is a CRITERION and not an instruction — the same fence the
 *   checkpoint travels behind, for the same reason;
 *
 *   which instances it grew from — so a wrong abstraction is obvious at a
 *   glance instead of being taken on the system's word;
 *
 *   that it is in force right now — because the point is to be corrected,
 *   and nobody corrects something they did not know was running.
 */
export function formatForSystemChannel(criteria: readonly Criterion[], features: readonly string[] = []): string {
  if (criteria.length === 0) return "";
  const because = features.length === 0 ? "" : `（这一步带着这些特征：${features.join("、")}）`;
  const lines = [`【判断标准】这一步我按的是下面这几条${because}：`];
  for (const criterion of criteria) {
    lines.push(
      "",
      `— ${criterion.claim}`,
      ...(criterion.boundary === undefined ? [] : [`  它在这里不成立：${criterion.boundary}`]),
      `  从 ${criterion.evidence.length} 次实例长出来的。`,
    );
  }
  lines.push("", "哪一条不对，到「判据」页改它或推翻它。");
  return lines.join("\n");
}
