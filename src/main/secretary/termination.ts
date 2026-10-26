// 移植自 Squad 2.x packages/secretary/src/termination.ts @ 8dcb903
/**
 * A terminal agenda summary is a hand-off document for the host and for any
 * later team. It is deliberately different from a context checkpoint: a
 * checkpoint is execution context, whereas this records why an agenda ended
 * and what a replacement agenda must pick up.
 */
export const TERMINATION_SUMMARY_HEADINGS = [
  "## 议程目标",
  "## 已完成事项",
  "## 中断原因",
  "## 未完成事项",
  "## 产出索引",
] as const;

export function buildTeamAgendaTerminationPrompt(input: {
  readonly objective: string;
  readonly reason: string;
  readonly completed: readonly string[];
  readonly remaining: readonly string[];
  readonly artifacts: readonly string[];
  readonly discussion: readonly string[];
}): string {
  return [
    "你是团队秘书。当前议程必须终止，请写一份供主持人与后续新议程使用的中止交接文档。",
    "只依据下面记录；不要编造完成项、文件或失败原因。",
    "严格使用下列五个 Markdown 标题，顺序不变。每一项都要写；没有内容时写“无”。",
    TERMINATION_SUMMARY_HEADINGS.join("\n"),
    `团队目标：${input.objective}`,
    `终止原因：${input.reason}`,
    `已完成事项：\n${input.completed.length === 0 ? "无" : input.completed.map((item) => `- ${item}`).join("\n")}`,
    `尚未完成事项：\n${input.remaining.length === 0 ? "无" : input.remaining.map((item) => `- ${item}`).join("\n")}`,
    `已写入文件：\n${input.artifacts.length === 0 ? "无" : input.artifacts.map((path) => `- ${path}`).join("\n")}`,
    `公开讨论记录：\n${input.discussion.length === 0 ? "无" : input.discussion.join("\n\n")}`,
  ].join("\n\n");
}

export function validateTeamAgendaTerminationSummary(
  text: string,
): { readonly ok: true } | { readonly ok: false; readonly missing: readonly string[] } {
  const missing = TERMINATION_SUMMARY_HEADINGS.filter((heading) => !text.includes(heading));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
