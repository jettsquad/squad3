// 移植自 Squad 2.x packages/shared/src/situation.ts @ 8dcb903
/**
 * situation.ts — the key a criterion is found by.
 *
 * The whole system turns on one decision: the key is the SITUATION, not the
 * text. 「不可见 = 不可纠正」 was learned from checkpoint folding and should
 * fire on automatic retry and automatic degradation — wording nothing alike,
 * situation identical. Text similarity never finds that; the situation finds
 * it first time. And that is the recall worth having: a same-topic reminder
 * is something the user would have thought of anyway, a cross-topic one only
 * the system can offer.
 *
 * It lives in shared because it has two consumers and cannot sit on either
 * side of the wall between them: ③ the secretary LABELS an agenda phase with
 * a situation while drafting it, and ④ Lil X uses the same vocabulary as the
 * key its criteria are filed under. A phase label the library cannot read
 * would be a label about nothing.
 *
 * Both lists are CLOSED, at 7 and 8. Extending either is a deliberate human
 * act, not something the system may do to itself while running — an open
 * vocabulary drifts, and a key that drifts stops matching what was filed
 * under it. Better to be short of labels at first than to lose the index.
 */

/** Axis two: what kind of thing is being decided right now. Closed, 7. */
export const ACTION_KINDS = [
  "design-mechanism",
  "evaluate-external",
  "choose-between",
  "set-parameter",
  "irreversible-operation",
  "produce-document",
  "adjudicate",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Human labels; the stored keys stay stable and English. */
export const ACTION_KIND_LABELS: Readonly<Record<ActionKind, string>> = {
  "design-mechanism": "设计一个机制",
  "evaluate-external": "评估外部方案",
  "choose-between": "在若干方案间取舍",
  "set-parameter": "定一个参数",
  "irreversible-operation": "执行不可逆操作",
  "produce-document": "产出文档",
  adjudicate: "裁定分歧",
};

/** Axis three: properties of the thing being decided about. Closed, 8. */
export const FEATURE_FLAGS = [
  "automatic",
  "invisible-result",
  "irreversible",
  "external-dependency",
  "changes-default",
  "multi-workspace",
  "order-of-magnitude",
  "benchmark-backed",
] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export const FEATURE_FLAG_LABELS: Readonly<Record<FeatureFlag, string>> = {
  automatic: "自动触发（无人确认）",
  "invisible-result": "结果不可见",
  irreversible: "不可逆",
  "external-dependency": "引入外部依赖",
  "changes-default": "改变默认行为",
  "multi-workspace": "涉及多个工作区/环境",
  "order-of-magnitude": "含数量级判断",
  "benchmark-backed": "有外部数据/benchmark 支撑",
};

/** Axis one: where in the problem-solving framework this is happening. */
export const FRAMEWORK_STEPS = ["clarify", "decompose", "search", "evaluate", "improve", "conclude", "verify"] as const;
export type FrameworkStep = (typeof FRAMEWORK_STEPS)[number];

/**
 * Where a decision is happening.
 *
 * Axes one and two the program can determine. Axis three it cannot — "the
 * result is invisible" is a property of the thing being designed, unknown
 * before the discussion starts — so the secretary drafts it into the agenda
 * and the host confirms it there, exactly as `artifactPath` works. Reusing a
 * mechanism that already runs beats inventing a second one.
 */
export interface Situation {
  readonly step?: FrameworkStep | undefined;
  readonly action: ActionKind;
  readonly features: readonly FeatureFlag[];
}

const ACTIONS = new Set<string>(ACTION_KINDS);
const FEATURES = new Set<string>(FEATURE_FLAGS);
const STEPS = new Set<string>(FRAMEWORK_STEPS);

export const isActionKind = (value: string): value is ActionKind => ACTIONS.has(value);
export const isFeatureFlag = (value: string): value is FeatureFlag => FEATURES.has(value);
export const isFrameworkStep = (value: string): value is FrameworkStep => STEPS.has(value);

/**
 * Read a situation from stored or model-supplied labels.
 *
 * Unknown labels are REFUSED, never dropped. A silently discarded feature
 * flag narrows a trigger without saying so, and the criterion then quietly
 * stops matching the situations it was written for — a criterion that never
 * fires is indistinguishable from one that was never written.
 */
export function parseSituation(input: {
  step?: string | undefined;
  action: string;
  features: readonly string[];
}): Situation {
  if (!isActionKind(input.action)) {
    throw new Error(
      `未知的动作类型「${input.action}」。列表是闭合的（${ACTION_KINDS.join("、")}），扩充要人显式动手。`,
    );
  }
  const unknown = input.features.filter((feature) => !isFeatureFlag(feature));
  if (unknown.length > 0) {
    throw new Error(`未知的特征标记：${unknown.join("、")}。列表是闭合的，扩充要人显式动手。`);
  }
  if (input.step !== undefined && !isFrameworkStep(input.step)) {
    throw new Error(`未知的框架位置「${input.step}」。`);
  }
  return {
    action: input.action,
    features: input.features as readonly FeatureFlag[],
    ...(input.step === undefined ? {} : { step: input.step as FrameworkStep }),
  };
}
