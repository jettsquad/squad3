// 移植自 Squad 2.x packages/reasoning/src/criterion.ts @ 8dcb903
/**
 * criterion.ts — a criterion, an instance, and the Markdown they live in.
 *
 * Structure gets it FOUND, prose gets it UNDERSTOOD, and neither alone works.
 * Pure prose cannot be filtered without reading everything through a model
 * each time; pure structure flattens the "why", and the why is the only part
 * of a criterion worth anything. So: a structured trigger decides whether to
 * fetch it, and natural language decides what to do with it once fetched.
 *
 * The same split is already proven at small scale — the context checkpoint's
 * four fixed headings are structure the assembler reads without parsing
 * prose, and its body is judgement. This is that, larger.
 *
 * The abstract/instance split is also the export boundary, which is why they
 * are separate files in separate directories rather than sections of one:
 * abstracts are transferable and may be given away, instances carry the
 * user's own project detail and never leave. One decision, not two.
 */
import type { ActionKind, FeatureFlag, FrameworkStep, Situation } from "../../shared/index.ts";
import { parseSituation } from "../../shared/index.ts";

/** When a criterion should be fetched. Coarse on purpose; the model refines. */
export interface Trigger {
  readonly action: readonly ActionKind[];
  /** Required features: a situation must carry all of them. */
  readonly features: readonly FeatureFlag[];
  readonly step?: readonly FrameworkStep[] | undefined;
}

export type CriterionStatus = "active" | "suspect" | "retired";

export interface Criterion {
  readonly id: string;
  readonly trigger: Trigger;
  /** The claim, in the user's own words. */
  readonly claim: string;
  /**
   * Where it does NOT apply.
   *
   * Grown from counter-examples and from nothing else. Without this field a
   * criterion becomes a slogan with no conditions attached, which is how a
   * useful judgement turns into dogma.
   */
  readonly boundary?: string | undefined;
  /** Instance ids. Evidence, and the only scale of confidence there is. */
  readonly evidence: readonly string[];
  readonly status: CriterionStatus;
}

/** One recorded occurrence. Never exported. */
export interface Instance {
  readonly id: string;
  readonly criterionId?: string | undefined;
  readonly situation: Situation;
  /** What the machine proposed. */
  readonly proposed: string;
  /** What the human made of it. */
  readonly verdict: string;
  /** Their reason, when they gave one — the most valuable line in the file. */
  readonly reason?: string | undefined;
  readonly project?: string | undefined;
  readonly at: string;
}

const FENCE = "---";

/** Serialize a criterion: front matter for the trigger, prose for the judgement. */
export function criterionToMarkdown(criterion: Criterion): string {
  const lines = [
    FENCE,
    `id: ${criterion.id}`,
    `status: ${criterion.status}`,
    `action: ${criterion.trigger.action.join(", ")}`,
    `features: ${criterion.trigger.features.join(", ")}`,
    ...(criterion.trigger.step === undefined ? [] : [`step: ${criterion.trigger.step.join(", ")}`]),
    `evidence: ${criterion.evidence.join(", ")}`,
    FENCE,
    "",
    "## 主张",
    criterion.claim.trim(),
  ];
  if (criterion.boundary !== undefined && criterion.boundary.trim() !== "") {
    lines.push("", "## 适用边界", criterion.boundary.trim());
  }
  return `${lines.join("\n")}\n`;
}

const sectionOf = (body: string, heading: string): string | undefined => {
  const start = body.indexOf(`## ${heading}`);
  if (start < 0) return undefined;
  const after = body.slice(start + heading.length + 3);
  const end = after.indexOf("\n## ");
  return (end < 0 ? after : after.slice(0, end)).trim();
};

const list = (raw: string | undefined): string[] =>
  raw === undefined
    ? []
    : raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "");

/**
 * Read a criterion back.
 *
 * Strict about the vocabulary and about the claim: a criterion whose claim
 * failed to parse would be fetched, delivered, and say nothing. Better to
 * refuse the file and be told which one.
 */
export function criterionFromMarkdown(text: string, sourceName = "criterion"): Criterion {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.trim() + "\n");
  if (match === null) throw new Error(`${sourceName}：缺少 front matter，无法解析。`);
  const [, front = "", body = ""] = match;

  const fields = new Map<string, string>();
  for (const line of front.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }

  const id = fields.get("id");
  if (id === undefined || id === "") throw new Error(`${sourceName}：front matter 缺 id。`);

  // Validated through the same closed-list parser the write path uses, so a
  // hand-edited file fails here rather than becoming a trigger that silently
  // never matches.
  const actions = list(fields.get("action"));
  const features = list(fields.get("features"));
  for (const action of actions) parseSituation({ action, features });
  const steps = list(fields.get("step"));
  for (const step of steps) parseSituation({ action: actions[0] ?? "adjudicate", features: [], step });

  const claim = sectionOf(body, "主张");
  if (claim === undefined || claim === "") throw new Error(`${sourceName}：缺少「## 主张」一节。`);

  const status = fields.get("status") ?? "active";
  if (status !== "active" && status !== "suspect" && status !== "retired") {
    throw new Error(`${sourceName}：未知状态「${status}」。`);
  }

  const boundary = sectionOf(body, "适用边界");
  return {
    id,
    trigger: {
      action: actions as ActionKind[],
      features: features as FeatureFlag[],
      ...(steps.length === 0 ? {} : { step: steps as FrameworkStep[] }),
    },
    claim,
    ...(boundary === undefined || boundary === "" ? {} : { boundary }),
    evidence: list(fields.get("evidence")),
    status,
  };
}

/** Serialize an instance. Stays local; the format is for a human reading it later. */
export function instanceToMarkdown(instance: Instance): string {
  const lines = [
    FENCE,
    `id: ${instance.id}`,
    ...(instance.criterionId === undefined ? [] : [`criterion: ${instance.criterionId}`]),
    `action: ${instance.situation.action}`,
    `features: ${instance.situation.features.join(", ")}`,
    ...(instance.situation.step === undefined ? [] : [`step: ${instance.situation.step}`]),
    ...(instance.project === undefined ? [] : [`project: ${instance.project}`]),
    `at: ${instance.at}`,
    FENCE,
    "",
    "## 机器提议",
    instance.proposed.trim(),
    "",
    "## 人的裁定",
    instance.verdict.trim(),
  ];
  if (instance.reason !== undefined && instance.reason.trim() !== "") {
    lines.push("", "## 理由", instance.reason.trim());
  }
  return `${lines.join("\n")}\n`;
}
