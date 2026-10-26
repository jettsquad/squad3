// 移植自 Squad 2.x packages/secretary/src/project-memory.ts @ 8dcb903
/**
 * project-memory.ts — rewriting a project file that has outgrown its limit.
 *
 * The file is written by Claude sessions, in and out of Squad, and they add
 * far more readily than they remove. Telling the person it grew does nothing
 * — they would only ask a Claude to shrink it — so Squad shrinks it itself,
 * against the same rules the file carries at its top.
 *
 * The secretary returns the BODY only. The rules block is put back on top by
 * the program (`withProjectMemoryRules`), so a rewrite that forgot it cannot
 * produce a file that then grows back with nothing to stop it.
 */
import {
  PROJECT_MEMORY_MAX_CHARS,
  PROJECT_MEMORY_RULES,
  projectMemoryRulesBlock,
  stripProjectMemoryRules,
} from "../../shared/index.ts";

export interface ProjectMemoryPromptInput {
  /** `CLAUDE.md` or `AGENTS.md`. */
  readonly file: string;
  /** The file as it is now, rules block and all. */
  readonly text: string;
}

/** Room left for the body once the rules block is back on top. */
export const projectMemoryBodyLimit = (): number => PROJECT_MEMORY_MAX_CHARS - projectMemoryRulesBlock().length - 2;

export const buildProjectMemoryPrompt = (input: ProjectMemoryPromptInput): string =>
  [
    `你在重写一个项目的 \`${input.file}\`。它已经超出上限，每个 agent 开工都要把它整份读一遍，多出来的每个字都在反复花钱。`,
    "写作规则：",
    ...PROJECT_MEMORY_RULES.map((rule) => `- ${rule}`),
    "重写要求：",
    `- 正文不超过 ${projectMemoryBodyLimit().toLocaleString("en-US")} 字符。这是硬上限，超了会被拒收。`,
    "- 仍然有效的硬性禁令、合规要求、踩坑结论一条都不能丢；压缩的是表述，不是这些事实。",
    "- 按规则该删的直接删，不要挪到别处，也不要留「详见某处」的指针，除非那个文件原文里就提到、而且只在特定任务里才用得上。",
    "- 不要编造原文里没有的路径、命令或结论。",
    "- 只输出新文件的正文：不要包含写作规则那一节（程序会放回去），不要解释你删了什么，不要用代码块包起来。",
    `=== 现在的 ${input.file} ===`,
    stripProjectMemoryRules(input.text),
  ].join("\n");

export type ProjectMemoryValidation = { readonly ok: true } | { readonly ok: false; readonly detail: string };

export const validateProjectMemory = (body: string): ProjectMemoryValidation => {
  const text = body.trim();
  if (text === "") return { ok: false, detail: "正文是空的" };
  const limit = projectMemoryBodyLimit();
  if (text.length > limit) return { ok: false, detail: `正文 ${text.length} 字符，超过上限 ${limit}` };
  return { ok: true };
};
