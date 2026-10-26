// 移植自 Squad 2.x packages/reasoning/src/distil.ts @ 8dcb903
/**
 * distil.ts — turning one occurrence into a proposal a human can rule on.
 *
 * The prompt lives here, not in `@squad/secretary`, even though the design
 * says 「秘书判断」. Both boundary tables already written say the criteria
 * library belongs to ④, and a prompt is a decision about what a model is
 * told — the same argument that moved the checkpoint prompt INTO the
 * secretary moves this one out of it. What the design means by 秘书判断 is
 * that a judgement model drafts and the human rules; that holds either way.
 *
 * The prompt is Chinese; the OUTPUT is not necessarily. It says so explicitly,
 * because without that line the model followed the instruction's language and
 * a library built from English occurrences came out in Chinese — or, as
 * actually happened, an English case produced an English criterion sitting
 * beside Chinese ones with no rule saying which was right. The language of a
 * criterion is not a UI setting: it belongs to the person whose standard it
 * is, and the case they said it in is the best evidence of that.
 *
 * Four relations, and the fourth is the one that matters. A counter-example
 * is the largest gradient the system can receive: it means either the
 * criterion is wrong, or its boundary is narrower than written. The second is
 * both more common and more valuable — 「不可见 = 不可纠正」 only learned
 * "unless the action is trivially reversible" from a case that contradicted
 * it. Without a counter-example channel an abstract grows more absolute with
 * every confirmation, until it is a slogan with no conditions attached.
 */
import { ACTION_KINDS, FEATURE_FLAGS, isActionKind, isFeatureFlag, type Situation } from "../../shared/index.ts";
import type { Criterion } from "./criterion.ts";

export type Relation = "new" | "reinforce" | "revise" | "counter-example";

export interface Distillation {
  readonly relation: Relation;
  /** Which existing criterion this bears on; absent for `new`. */
  readonly criterionId?: string | undefined;
  readonly claim: string;
  readonly boundary?: string | undefined;
  /**
   * When this should be fetched — the ESSENTIAL features, not every feature
   * the originating case happened to have.
   *
   * Chosen by the distillation rather than copied from the instance. Copying
   * makes the trigger exactly as narrow as the one case that produced it, and
   * a trigger is a coarse filter by design: a later selection step reads
   * 適用邊界, so the filter only has to be roughly right. Observed: a
   * criterion learned from designing an auto-fold mechanism did not fire on a
   * phase labelled "design an auto-fold mechanism", because the instance
   * carried two features and the phase was labelled with one. The design
   * already names this failure — "never recalled → the trigger is wrong".
   */
  readonly triggerFeatures?: readonly string[] | undefined;
  /**
   * Which kinds of decision this should fire on.
   *
   * Chosen by the distillation for the same reason the features are, and
   * against the same observed failure: an occurrence carries ONE action kind,
   * and copying it makes the trigger as narrow as the single case behind it.
   * The library already holds a criterion filed under `adjudicate` alone that
   * has never once been recalled — a standard about not flattening
   * disagreement is not confined to the moment of adjudicating.
   *
   * More than one is normal. This is a coarse filter with a selection step
   * behind it, so being roughly right in several places beats being exactly
   * right in one.
   */
  readonly triggerActions?: readonly string[] | undefined;
}

export interface DistilInput {
  readonly situation: Situation;
  /** What the machine proposed. */
  readonly proposed: string;
  /** What the human made of it. */
  readonly verdict: string;
  readonly reason?: string | undefined;
  /** Existing criteria that might already cover this. */
  readonly candidates: readonly Criterion[];
}

export function buildDistilPrompt(input: DistilInput): string {
  const candidates =
    input.candidates.length === 0
      ? "（当前没有相关的已有判据。）"
      : input.candidates
          .map(
            (c) => `- id: ${c.id}\n  主张：${c.claim}${c.boundary === undefined ? "" : `\n  已有边界：${c.boundary}`}`,
          )
          .join("\n");
  return [
    "你在维护一个人的「判断标准库」。刚刚发生了一件事：机器提议了什么，人否决或修改了它。",
    "你的任务是判断这件事和已有判据的关系，并给出一条**抽象**的表述。",
    "",
    "四种关系，只能选一种：",
    "- new：没有已有判据覆盖这件事，需要新建一条。",
    "- reinforce：支持某条已有判据，不改表述。",
    "- revise：某条已有判据的表述不准，要改。",
    "- counter-example：**与某条已有判据冲突**。这时通常不是推翻它，而是**收窄它的适用边界**——",
    "  写清楚「在什么情况下不适用」。这一种最有价值，不要因为怕冲突就避开它。",
    "",
    "写抽象表述时：",
    "- 写**标准**，不要写**结论**。「他选了 Postgres」是结论；「他要求给出迁移成本估算才接受选型」是标准。",
    "  这个区别是整件事的生死线：结论没法迁移到别的处境，标准可以。",
    "- 去掉项目名、人名、具体文件名。抽象要能给别人用。",
    "- **用这次案例本身的语言写**：上面「机器提议 / 人的裁定 / 人给的理由」是什么语言，" +
      "claim 和 boundary 就用什么语言。这段指令是中文的，但它只是在指挥你，不决定判据的语言。" +
      "案例几种语言混着的时候，看「人的裁定」和「人给的理由」——判据是这个人的标准，" +
      "该用他说话的那种语言留下来。",
    "",
    "另外给出**触发条件**：这条判据以后应该在什么处境下被捞出来。",
    "- triggerActions 填这条判据该在哪几类决策上生效，可以多填几类。",
    "  **不要只填这次碰巧发生的那一类**——一条「分歧不许压成共识」的判据，",
    "  不只在裁决的时候成立，评估外部方案、在几个选项里选的时候一样成立。",
    "- triggerFeatures 只填**必要**的特征，不要把这次碰巧带有的特征全填上。",
    "  触发条件是**粗过滤**——捞出来之后还有一步精选去读适用边界，所以宁可宽一点。",
    "  填全了会让这条判据只在与这一次一模一样的处境下才触发，等于永远捞不出来。",
    "",
    "只回复一个 JSON 对象，不要有别的文字：",
    '{"relation": "new"|"reinforce"|"revise"|"counter-example", "criterionId"?: string, "claim": string, "boundary"?: string, "triggerActions": string[], "triggerFeatures": string[]}',
    "relation 不是 new 时，criterionId 必填，且必须是下面列出的 id 之一。",
    "",
    `这次的处境：动作类型=${input.situation.action}，特征=${input.situation.features.join("、") || "（无）"}${
      input.situation.step === undefined ? "" : `，框架位置=${input.situation.step}`
    }`,
    `机器提议：${input.proposed}`,
    `人的裁定：${input.verdict}`,
    ...(input.reason === undefined ? [] : [`人给的理由：${input.reason}`]),
    "",
    `已有判据：\n${candidates}`,
    "",
    `（参考）动作类型闭合列表：${ACTION_KINDS.join("、")}`,
    `（参考）特征标记闭合列表：${FEATURE_FLAGS.join("、")}`,
  ].join("\n");
}

const RELATIONS = new Set<string>(["new", "reinforce", "revise", "counter-example"]);

/**
 * Read the distillation back.
 *
 * A relation that names no existing criterion is refused rather than
 * downgraded to `new`: quietly turning a counter-example into a fresh
 * criterion is how a library ends up holding two claims that contradict each
 * other, with nothing recording that they ever met.
 */
export function parseDistillation(text: string, candidates: readonly Criterion[]): Distillation {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("提炼没有返回 JSON 对象。");
  const raw = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;

  const relation = raw["relation"];
  if (typeof relation !== "string" || !RELATIONS.has(relation)) {
    throw new Error(`提炼返回了未知的关系「${String(relation)}」。`);
  }
  const claim = raw["claim"];
  if (typeof claim !== "string" || claim.trim() === "") throw new Error("提炼没有给出主张。");

  const criterionId = typeof raw["criterionId"] === "string" ? raw["criterionId"] : undefined;
  if (relation !== "new") {
    if (criterionId === undefined) throw new Error(`关系是「${relation}」，却没有指出是哪一条判据。`);
    if (!candidates.some((candidate) => candidate.id === criterionId)) {
      throw new Error(`关系是「${relation}」，但 ${criterionId} 不在候选判据里。`);
    }
  }
  const boundary =
    typeof raw["boundary"] === "string" && raw["boundary"].trim() !== "" ? raw["boundary"].trim() : undefined;
  // Unknown feature names are refused rather than filtered out. Silently
  // dropping one narrows the trigger without saying so — the same failure
  // this field exists to fix, arriving by a different route.
  const rawFeatures = raw["triggerFeatures"];
  let triggerFeatures: readonly string[] | undefined;
  if (Array.isArray(rawFeatures)) {
    for (const feature of rawFeatures) {
      if (typeof feature !== "string" || !isFeatureFlag(feature)) {
        throw new Error(`提炼给出的触发特征「${String(feature)}」不在闭合列表里。`);
      }
    }
    triggerFeatures = rawFeatures as readonly string[];
  }

  // Same treatment as the features: an unknown action name is refused, not
  // dropped. A silently discarded action narrows the trigger without saying
  // so, which is the failure this field was added to prevent.
  const rawActions = raw["triggerActions"];
  let triggerActions: readonly string[] | undefined;
  if (Array.isArray(rawActions)) {
    for (const action of rawActions) {
      if (typeof action !== "string" || !isActionKind(action)) {
        throw new Error(`提炼给出的触发动作「${String(action)}」不在闭合列表里。`);
      }
    }
    if (rawActions.length > 0) triggerActions = rawActions as readonly string[];
  }

  return {
    relation: relation as Relation,
    ...(criterionId === undefined ? {} : { criterionId }),
    claim: claim.trim(),
    ...(boundary === undefined ? {} : { boundary }),
    ...(triggerFeatures === undefined ? {} : { triggerFeatures }),
    ...(triggerActions === undefined ? {} : { triggerActions }),
  };
}
