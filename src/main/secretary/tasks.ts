// 移植自 Squad 2.x packages/secretary/src/tasks.ts @ 8dcb903
/**
 * tasks.ts — what the secretary writes, and what it refuses.
 *
 * Separated from the service so the refusals are testable without a harness.
 * They are the part worth testing: the prompt builders already have their own
 * tests, and the service around this is a thin adapter that hands a subagent
 * some text. What matters is what happens when the answer comes back wrong,
 * and that is exactly the path an integration test exercises least.
 */
import type { AgendaSpec } from "../../shared/index.ts";
import { assertPublicHostCommand, buildAgendaPrompt, parseAgendaReply, type AgendaDraftInput } from "./agenda.ts";
import {
  buildCheckpointPrompt,
  normalizeCheckpoint,
  validateCheckpoint,
  type CheckpointPromptInput,
} from "./checkpoint.ts";
import { buildTeamAgendaTerminationPrompt, validateTeamAgendaTerminationSummary } from "./termination.ts";
import { buildAssistPrompt, validateAssist, type AssistInput } from "./assist.ts";
import { buildProjectMemoryPrompt, validateProjectMemory, type ProjectMemoryPromptInput } from "./project-memory.ts";
import { buildQuietPrompt, parseQuietReply, type QuietJudgement, type QuietJudgementInput } from "./quiet.ts";

/** What one finished text task produced. */
export interface TextTaskResult {
  readonly text: string;
  /** dsh's stop reason; only `completed` is an answer. */
  readonly stopReason: string;
}

/** Runs one self-contained text task and returns its result. */
export type TextTaskRunner = (label: string, prompt: string) => Promise<TextTaskResult>;

/** Everything the hand-off document needs. */
export interface TerminationInput {
  readonly objective: string;
  readonly reason: string;
  readonly completed: readonly string[];
  readonly remaining: readonly string[];
  readonly artifacts: readonly string[];
  readonly discussion: readonly string[];
}

/**
 * Write the context checkpoint that stands in for the discussion it folds.
 *
 * Refused unless all four headings are present. A checkpoint missing
 * 「未决分歧」 does not read as broken — it reads as a team that agreed, and
 * every later round inherits a consensus that never happened.
 */
export async function writeCheckpointWith(run: TextTaskRunner, input: CheckpointPromptInput): Promise<string> {
  const text = await settled(run, "秘书 · 检查点", buildCheckpointPrompt(input));
  const check = validateCheckpoint(text);
  if (!check.ok) {
    throw new Error(
      `秘书写出的检查点缺少标题：${check.missing.join("、")}。` +
        `检查点是后续每一轮的历史，残缺的那一节会被当成「这方面没有内容」，而不是「这里丢了」。`,
    );
  }
  return normalizeCheckpoint(text);
}

/**
 * Write the hand-off for an agenda that was stopped early.
 *
 * Same refusal, same reason: a hand-off with a hole reads as complete to
 * whoever picks it up, and starts them in the wrong place.
 */
export async function writeTerminationWith(run: TextTaskRunner, input: TerminationInput): Promise<string> {
  const text = await settled(run, "秘书 · 中止交接", buildTeamAgendaTerminationPrompt(input));
  const check = validateTeamAgendaTerminationSummary(text);
  if (!check.ok) {
    throw new Error(
      `秘书写出的中止交接文档缺少标题：${check.missing.join("、")}。` +
        `交接文档缺一节，接手的人会当成那一节本来就没有内容，从错的地方开始。`,
    );
  }
  return text;
}

/**
 * Rewrite a project file that has outgrown its limit. Returns the BODY; the
 * caller puts the rules block back on top.
 *
 * Refused when it comes back empty or still over the limit. Either would be
 * written into the person's project, and a file that is empty or still too
 * big is worse than the one it replaced.
 */
export async function compressProjectMemoryWith(run: TextTaskRunner, input: ProjectMemoryPromptInput): Promise<string> {
  const text = await settled(run, "秘书 · 精简项目文件", buildProjectMemoryPrompt(input));
  const check = validateProjectMemory(text);
  if (!check.ok) throw new Error(`秘书精简 ${input.file} 的结果不予采用：${check.detail}。`);
  return text.trim();
}

/**
 * Run a task and accept only a completed one.
 *
 * A stop reason other than `completed` is an error, not a short answer.
 * `max-tokens` is the dangerous one: it returns real text that simply stops
 * partway, so it can pass heading validation and still end mid-sentence.
 */
async function settled(run: TextTaskRunner, label: string, prompt: string): Promise<string> {
  const result = await run(label, prompt);
  if (result.stopReason !== "completed") {
    // Whatever text came back travels with the refusal. A subagent result
    // carries no error detail — the cause goes to the harness logger and
    // nowhere the caller can see — so the partial output is the only evidence
    // available at this layer, and a refusal naming only a stop reason leaves
    // a real failure with nothing to debug from.
    const partial = result.text.trim();
    throw new Error(
      `秘书任务「${label}」未完成（${result.stopReason}），产出不予采用。` +
        (partial === "" ? "（子进程没有返回任何文本。）" : `子进程返回的片段：${partial.slice(0, 300)}`),
    );
  }
  return result.text;
}

/**
 * Draft an agenda from the host's instruction.
 *
 * The private-material check runs BEFORE the model is contacted, not after:
 * the point is that the reference never reaches the secretary, and a check on
 * the way back would have already sent it.
 *
 * A draft, never a schedule. Nothing here starts anything — the host confirms
 * it, and that is what makes a wrong agenda cost a click instead of an
 * afternoon.
 */
export async function draftAgendaWith(run: TextTaskRunner, input: AgendaDraftInput): Promise<AgendaSpec> {
  assertPublicHostCommand(input.command);
  return runDraft(run, input);
}

/**
 * Build, run and parse, with no guard.
 *
 * The guard is about the HOST's own sentence — an `@` there points at
 * material only the host can see, and the secretary is private-blind. It is
 * not about text that came out of the record, and applying it there was a
 * real bug: converting a secretary reply embedded that reply in the prompt,
 * the reply naturally contained 「@吴二」, and every conversion was
 * refused with 「主持人指令里的 @ 引用不会发给秘书」 — a message about a
 * sentence the host never wrote.
 */
async function runDraft(run: TextTaskRunner, input: AgendaDraftInput): Promise<AgendaSpec> {
  const text = await settled(run, "秘书 · 议程草案", buildAgendaPrompt(input));
  return parseAgendaReply(text, input.seats);
}

/**
 * Do one job for the host, off the record.
 *
 * The private-material check runs first, as it does for the agenda: the point
 * is that the reference never reaches the secretary, and checking on the way
 * back would mean it already had.
 *
 * The answer is returned, not recorded. It is a draft for the host — the
 * caller decides whether any of it becomes something the team said.
 */
export async function assistWith(run: TextTaskRunner, input: AssistInput): Promise<string> {
  assertPublicHostCommand(input.instruction);
  const text = await settled(run, "秘书 · 助理任务", buildAssistPrompt(input));
  const check = validateAssist(text);
  if (!check.ok) throw new Error(`秘书没有交出可用的结果：${check.detail ?? "内容为空"}`);
  return text;
}

/**
 * Turn something the secretary already said into a structured agenda.
 *
 * 1.x's move, and the one that makes a secretary an organiser rather than a
 * note-taker: you ask it IN THE DISCUSSION how the work should be divided, it
 * answers in prose the whole team can see and argue with, and only then is
 * that prose converted into phases and tasks. The alternative — asking for
 * JSON up front — hides the plan inside a schema at exactly the moment it
 * should be readable.
 *
 * The reply travels as text the CALLER pulled from the record, and the caller
 * is responsible for it having been the secretary's own. Nothing here can
 * check that: this layer never sees the record.
 */
export async function agendaFromReplyWith(
  run: TextTaskRunner,
  input: AgendaDraftInput & { readonly reply: string },
): Promise<AgendaSpec> {
  const command = [
    "把下面这段你自己写过的安排，原样转成结构化议程。",
    "不要改变分工、顺序或者谁做什么；这一步只是换一种表示，不是重新规划。",
    "如果那段话里没有说清某个阶段该谁做，就按它字面上的意思来，不要替它补。",
    "=== 你写过的安排 ===",
    input.reply,
    "=== 主持人的原始要求 ===",
    input.command,
  ].join("\n");
  // The host's ORIGINAL sentence is checked; the reply is not. It is already
  // public — it is in the record, every seat read it — and it is the secretary's
  // own words being handed back to it.
  assertPublicHostCommand(input.command);
  return runDraft(run, { ...input, command });
}

/**
 * Judge whether a quiet command should be waited for.
 *
 * Never throws for an unreadable answer — `parseQuietReply` turns that into
 * `ask` — but does throw when the secretary could not be run at all, so the
 * caller can say WHY nobody judged instead of inventing a verdict.
 */
export async function judgeQuietWith(run: TextTaskRunner, input: QuietJudgementInput): Promise<QuietJudgement> {
  return parseQuietReply(await settled(run, "秘书 · 静默判断", buildQuietPrompt(input)));
}
