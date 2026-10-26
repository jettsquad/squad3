// 移植自 Squad 2.x packages/shared/src/project-memory.ts @ 8e96d9c
/**
 * project-memory.ts — the file each backend reads as project context.
 *
 * Every CLI has one and they are all different: Claude Code reads
 * `CLAUDE.md`, Codex reads `AGENTS.md`. They are not interchangeable and do
 * not need to be — each seat reads its own, and nothing has to know about
 * anyone else's.
 *
 * What belongs in one is what is true of the PROJECT: what it is for, how it
 * is laid out, the conventions and vocabulary it uses. Not a seat's persona
 * and not a way of working — those are the agent's own standing instructions,
 * which Squad already owns and which would drift here into something no
 * screen in Squad can show.
 *
 * The list is deliberately partial. `dsh` has no such convention, and giving
 * it one Squad invented would be a file nothing reads.
 */
import type { AgentBackend } from "./agent-template.ts";

const BY_BACKEND: Readonly<Partial<Record<AgentBackend, string>>> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
};

/** The project file this backend reads, when it has such a convention. */
export function projectMemoryFile(backend: AgentBackend): string | undefined {
  return BY_BACKEND[backend];
}

/**
 * The most a project file may hold, in characters.
 *
 * Measured, not picked: a HikingHub `CLAUDE.md` written by Claude itself grew
 * to 89k characters — deprecated designs kept "for reference", a changelog,
 * acknowledgements, a disclaimer, a repo bootstrap tutorial — and every seat
 * opening a conversation paid ~68k tokens for it, then re-read it on every
 * model call after. A limit only works if it is written where the writer
 * reads it, which is why it travels inside `PROJECT_MEMORY_RULES` too.
 */
export const PROJECT_MEMORY_MAX_CHARS = 15_000;

/**
 * How a project file is written — the rules, one per line.
 *
 * One list, used in three places so they cannot drift: the errand that has a
 * seat create the file, the secretary's compression prompt, and the header
 * kept at the top of the file itself. The header is the one that matters
 * most: the file is mostly edited OUTSIDE Squad, by whatever Claude session
 * is open in the project, and the only instruction every such session is
 * guaranteed to read is the file.
 */
export const PROJECT_MEMORY_RULES: readonly string[] = [
  "项目边界是当前团队的项目目录。自动建档不得读取父目录、同级项目或目录外的记忆来推断项目背景；目录为空或事实不足时明确写尚未确定，等待主持人说明。",
  "只写「不读就会做错」的项目事实：项目是干什么的、各目录负责什么、架构和约定、硬性禁令、踩过的坑和结论。",
  "不写：变更历史和「某日更新了什么」（git log 里有）；已作废的设计（直接删掉，不要标「已停用」留着）；" +
    "致谢、免责声明、许可证；一次性的安装或初始化教程；完整文件树、大段命令清单、从代码里就能直接读到的东西；" +
    "你自己的角色或工作方式（那些由团队给你）。",
  "写结论不写过程：一个坑写成「现象 → 原因 → 怎么做」一两行，不写排查经过。",
  "只有特定任务才用得上的长说明（比如某个平台的发布步骤）放进单独的文件，这里用普通文字写一行路径。" +
    "不要用 `@路径` 导入：导入会被整份加载，等于没挪。",
  `全文不超过 ${PROJECT_MEMORY_MAX_CHARS.toLocaleString("en-US")} 字符。要加新内容而会超出时，先删最过时、最少用到的，再加。`,
  "改这份文件时，开头这一节规则原样保留。",
];

/** Markers around the rules block, so a program can find and replace it without parsing prose. */
export const PROJECT_MEMORY_RULES_BEGIN = "<!-- squad:rules -->";
export const PROJECT_MEMORY_RULES_END = "<!-- /squad:rules -->";

/** The rules block as it sits at the top of the file. */
export function projectMemoryRulesBlock(): string {
  return [
    PROJECT_MEMORY_RULES_BEGIN,
    "## 本文件的写法（改之前先读）",
    ...PROJECT_MEMORY_RULES.map((rule) => `- ${rule}`),
    PROJECT_MEMORY_RULES_END,
  ].join("\n");
}

/** The file with its rules block removed — what is left is the content the rules govern. */
export function stripProjectMemoryRules(text: string): string {
  const begin = text.indexOf(PROJECT_MEMORY_RULES_BEGIN);
  const end = text.indexOf(PROJECT_MEMORY_RULES_END);
  if (begin < 0 || end < begin) return text;
  return (text.slice(0, begin) + text.slice(end + PROJECT_MEMORY_RULES_END.length)).replace(/^\s+/, "");
}

/**
 * The file as it should be written: the rules block on top, then the body.
 *
 * Put together by the PROGRAM, never left to whoever wrote the body. A
 * compression that dropped the rules would produce a file that grows back
 * unchecked, and nothing would say the guard had gone.
 */
export function withProjectMemoryRules(body: string): string {
  return `${projectMemoryRulesBlock()}\n\n${stripProjectMemoryRules(body).trim()}\n`;
}

/** Initial notes contain only the declared project root, never inferred project facts. */
export function initialProjectMemory(projectFolder: string): string {
  return withProjectMemoryRules(
    [
      "# 项目说明",
      `本团队的项目目录：${projectFolder}`,
      "项目目标、技术栈、目录职责和约定尚未由主持人确认。",
      "空目录是独立的新项目，不代表代码位于父目录或同级目录。不得将其他项目的事实写入本文件。",
      "只根据主持人明确提供的信息与本项目目录内已确认的文件补充事实；没有事实时先询问，不要猜测。",
    ].join("\n\n"),
  );
}

/**
 * What a seat is told when its project file is missing.
 *
 * Written as the FIRST thing to do and then get on with the question, rather
 * than as a separate errand: a seat that spends its whole turn on
 * housekeeping has not answered, and the round it was part of has a hole in
 * it that reads as the seat having nothing to say.
 *
 * The rules travel with the errand, and the seat is told to put them at the
 * top of the file: a file born without them is the file that grows to 89k.
 */
export function projectMemoryNote(file: string): readonly string[] {
  return [
    `## 这个项目还没有 ${file}`,
    `先花一点时间建立 \`${file}\`：写这个项目是干什么的、目录怎么组织、有哪些约定和术语。` +
      `只写项目本身的事实，不要写你自己的角色或工作方式——那些由团队给你。`,
    "写的时候守下面这些规则，并把这一整段原样放在文件最开头：",
    projectMemoryRulesBlock(),
    "写完就继续回答下面的问题，不要把这一轮全用在这件事上。",
  ];
}
