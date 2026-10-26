/**
 * slash.ts — the 11 slash commands, typed in the box.
 *
 * In 2.x these were dsh slash commands and the ONLY way to drive a team: a
 * command runs because a person typed it, and its result never enters any
 * model's history. In Squad 3 the box is ours and no route from a seat can
 * reach it, so they are shortcuts rather than a fence — but the rule that
 * their output is shown to the person and not recorded as discussion stays.
 *
 * Every 2.x command is listed, including the ones whose feature arrives in a
 * later phase: typing one of those says so, instead of being sent to the team
 * as an instruction that happens to start with a slash.
 */

export type SlashName =
  | "squad-new"
  | "squad-design"
  | "squad-build"
  | "squad-teams"
  | "squad-say"
  | "squad-record"
  | "squad-window"
  | "squad-fold"
  | "squad-criteria"
  | "squad-accept"
  | "squad-reject";

export interface SlashSpec {
  readonly name: SlashName;
  readonly summary: string;
  readonly usage: string;
  /** The phase that brings it; absent when it works now. */
  readonly later?: number | undefined;
}

export const SLASH_COMMANDS: readonly SlashSpec[] = [
  { name: "squad-new", summary: "建一支团队", usage: "团队名 | 项目文件夹 | 甲*=角色, 乙=角色（* 标记秘书）" },
  { name: "squad-design", summary: "建一支「组队团队」", usage: "空文件夹的绝对路径，或留空" },
  { name: "squad-build", summary: "把设计出来的方案建成真团队", usage: "项目文件夹（绝对路径）" },
  { name: "squad-teams", summary: "列出团队并切换", usage: "留空看列表，或给团队名切换" },
  { name: "squad-say", summary: "向当前团队发一条指令", usage: "指令，或「甲,乙: 指令」只问部分席位" },
  { name: "squad-record", summary: "看团队记录", usage: "无参数" },
  { name: "squad-window", summary: "看某个席位这一轮会看到什么", usage: "席位名，留空用第一个" },
  { name: "squad-fold", summary: "现在折叠一次，把讨论换成检查点", usage: "无参数" },
  { name: "squad-criteria", summary: "看 Lil X 的判据与待裁定", usage: "无参数" },
  { name: "squad-accept", summary: "采纳一条待裁定的判据", usage: "判据 id" },
  { name: "squad-reject", summary: "否掉一条待裁定的判据", usage: "判据 id" },
];

export type SlashParse =
  | { readonly kind: "none" }
  | { readonly kind: "command"; readonly spec: SlashSpec; readonly args: string }
  | { readonly kind: "unknown"; readonly name: string };

/**
 * Whether the box holds a slash command.
 *
 * Only `/squad-…` is a command. A sentence that merely starts with a slash —
 * a path, `/etc/hosts 怎么改` — goes to the team as written.
 */
export function parseSlash(text: string): SlashParse {
  const match = /^\/(squad-[a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return { kind: "none" };
  const name = match[1] ?? "";
  const spec = SLASH_COMMANDS.find((command) => command.name === name);
  if (spec === undefined) return { kind: "unknown", name };
  return { kind: "command", spec, args: (match[2] ?? "").trim() };
}

/** The commands a partly typed `/squad-…` could be, for the menu. */
export function slashCandidates(text: string): readonly SlashSpec[] {
  const typed = /^\/([a-z-]*)$/.exec(text.trim())?.[1];
  if (typed === undefined) return [];
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(typed));
}
