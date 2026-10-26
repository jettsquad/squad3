// 移植自 Squad 2.x packages/reasoning/src/usage.ts @ 8dcb903
/**
 * usage.ts — the three scales a criterion is checked against.
 *
 * A criteria library with no self-correction becomes a set of slogans that
 * nobody can tell are wrong. These are the checks:
 *
 *   DELIVERED  — relevance. Never recalled means the trigger is wrong, not
 *                that the claim is unpopular.
 *   OUTCOME    — effectiveness. Delivered for months and never changing a
 *                decision means it is decoration.
 *   COUNTER    — truthfulness. Lots of evidence and NEVER a counter-example
 *                is the suspicious case, not the reassuring one: either the
 *                claim is too vague to contradict, or nobody is testing it.
 *
 * Two of these the program can count exactly. The third it cannot — whether a
 * decision changed BECAUSE of a criterion is not visible from here — so it is
 * a mark the human leaves, not an inference. Inventing a proxy for it would
 * produce a number that looks like measurement and is not.
 *
 * Usage stays on the local side of the export boundary, with instances. Given
 * someone else's abstract, you should not receive their delivery counts;
 * given yours away, you should not hand over how you have been working.
 */

export interface UsageRecord {
  readonly criterionId: string;
  /** Times this was surfaced to the host side. */
  readonly delivered: number;
  /** Times a capture contradicted it. */
  readonly counterExamples: number;
  /** Human marks: it changed what I did / it did not. */
  readonly helpful: number;
  readonly unhelpful: number;
  /** The human's adjudications of proposals for this criterion. */
  readonly accepted: number;
  readonly rejected: number;
  readonly lastDeliveredAt?: string | undefined;
}

export const emptyUsage = (criterionId: string): UsageRecord => ({
  criterionId,
  delivered: 0,
  counterExamples: 0,
  helpful: 0,
  unhelpful: 0,
  accepted: 0,
  rejected: 0,
});

/**
 * How much evidence may pile up before "never contradicted" becomes a
 * question rather than a comfort.
 *
 * Five: enough that silence is informative, small enough to actually fire.
 * A criterion nobody has ever managed to contradict after five separate
 * occasions is either genuinely solid or unfalsifiable, and those two look
 * identical from the outside — which is exactly why it needs a human to look.
 */
export const REVIEW_AFTER_EVIDENCE = 5;

export type HealthVerdict = "ok" | "never-delivered" | "never-contradicted" | "delivered-but-inert";

export interface Health {
  readonly criterionId: string;
  readonly verdict: HealthVerdict;
  readonly detail: string;
  readonly usage: UsageRecord;
}

/**
 * Judge one criterion against the three scales.
 *
 * Order matters: a criterion that was never delivered cannot be judged on
 * effectiveness or on the absence of counter-examples, and reporting it as
 * "never contradicted" would read as a compliment for having never been
 * anywhere near a decision.
 */
export function healthOf(usage: UsageRecord, evidenceCount: number, reviewAfter = REVIEW_AFTER_EVIDENCE): Health {
  const base = { criterionId: usage.criterionId, usage };
  if (usage.delivered === 0) {
    return {
      ...base,
      verdict: "never-delivered",
      detail: "从没被捞出来过——触发条件写错了，不是这条主张不受欢迎。",
    };
  }
  if (evidenceCount >= reviewAfter && usage.counterExamples === 0) {
    return {
      ...base,
      verdict: "never-contradicted",
      detail: `攒了 ${evidenceCount} 条证据却从未出现反例：要么它笼统到无法被反驳，要么没人在检验它。`,
    };
  }
  if (usage.delivered >= reviewAfter && usage.helpful === 0 && usage.unhelpful > 0) {
    return {
      ...base,
      verdict: "delivered-but-inert",
      detail: `投放了 ${usage.delivered} 次，被明确标为「没起作用」${usage.unhelpful} 次，从未被标为有用。`,
    };
  }
  return { ...base, verdict: "ok", detail: "三个刻度暂无异常。" };
}

const FENCE = "---";

export function usageToMarkdown(usage: UsageRecord): string {
  return [
    FENCE,
    `criterion: ${usage.criterionId}`,
    `delivered: ${usage.delivered}`,
    `counterExamples: ${usage.counterExamples}`,
    `helpful: ${usage.helpful}`,
    `unhelpful: ${usage.unhelpful}`,
    `accepted: ${usage.accepted}`,
    `rejected: ${usage.rejected}`,
    ...(usage.lastDeliveredAt === undefined ? [] : [`lastDeliveredAt: ${usage.lastDeliveredAt}`]),
    FENCE,
    "",
  ].join("\n");
}

const number = (raw: string | undefined): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export function usageFromMarkdown(text: string, sourceName = "usage"): UsageRecord {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0 && !line.startsWith("---")) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const criterionId = fields.get("criterion");
  if (criterionId === undefined || criterionId === "") throw new Error(`${sourceName}：缺 criterion。`);
  const lastDeliveredAt = fields.get("lastDeliveredAt");
  return {
    criterionId,
    delivered: number(fields.get("delivered")),
    counterExamples: number(fields.get("counterExamples")),
    helpful: number(fields.get("helpful")),
    unhelpful: number(fields.get("unhelpful")),
    accepted: number(fields.get("accepted")),
    rejected: number(fields.get("rejected")),
    ...(lastDeliveredAt === undefined || lastDeliveredAt === "" ? {} : { lastDeliveredAt }),
  };
}
