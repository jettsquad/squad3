// 移植自 Squad 2.x packages/console/src/parse.ts @ 8dcb903
// 改动：「绝对路径」原来只认以 / 开头（macOS），改成 isAbsolutePath，同时认 J:\ 与 \\server\ 这样的 Windows 路径。
/**
 * parse.ts — the grammar a person types.
 *
 * Slash commands are the only way to drive a team, and they are deliberately
 * NOT tools an agent calls. A model that chose which seats to ask would be
 * chairing the meeting, which is the one thing this product must not be. A
 * command runs because a person typed it; the registry never submits it to
 * the model, and the result is rendered by the UI without entering model
 * history. The invariant that the host node runs no turns is worth nothing if
 * the surface above it puts an LLM back in the chair.
 *
 * Pure, and tested, because this reads human input: a grammar that silently
 * mis-parses produces a team with the wrong seats and says nothing.
 */

/** Absolute on POSIX (/…) or Windows (J:\…, \\\\server\\share). Relative paths resolve against wherever Squad happens to run. */
export function isAbsolutePath(path: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

export interface SeatDraft {
  readonly seatId: string;
  readonly displayName: string;
  readonly role: string;
  readonly isSecretary: boolean;
}

export interface NewTeamInput {
  readonly displayName: string;
  readonly projectFolder: string;
  readonly seats: readonly SeatDraft[];
}

/**
 * `名称 | 项目文件夹 | 甲*=架构, 乙=测试`
 *
 * Pipes rather than positional whitespace, because a project folder can
 * contain spaces and a role certainly can. Roles are optional; the name alone
 * is a seat.
 *
 * A trailing `*` on a name designates the secretary. Designating one at
 * creation matters because it is the only seat that can be told to plan an
 * agenda; a team built without one has to be edited before it can do the
 * thing teams exist for, and nothing in the create form said so.
 */
export function parseNewTeam(raw: string): NewTeamInput {
  const parts = raw.split("|").map((part) => part.trim());
  const [displayName = "", projectFolder = "", roster = ""] = parts;
  if (parts.length < 3 || displayName === "" || projectFolder === "" || roster === "") {
    throw new Error("用法：/squad-new 团队名 | 项目文件夹 | 甲*=角色, 乙=角色（* 标记秘书）");
  }
  if (!isAbsolutePath(projectFolder)) {
    // Relative paths would resolve against whatever the harness's cwd happens
    // to be, which is not where the person thinks they are.
    throw new Error(`项目文件夹要写绝对路径：「${projectFolder}」不是。`);
  }

  const seats: SeatDraft[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of roster
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .entries()) {
    const [marked = "", role = ""] = entry.split(/[=＝:：]/).map((s) => s.trim());
    const isSecretary = marked.endsWith("*") || marked.endsWith("＊");
    const name = isSecretary ? marked.slice(0, -1).trim() : marked;
    if (name === "") throw new Error(`第 ${index + 1} 个席位没有名字。`);
    if (seen.has(name)) throw new Error(`席位名「${name}」重复了——同名席位在记录里分不开。`);
    seen.add(name);
    // Refused here as well as in `checkRoster`, because this message can
    // point at what was typed. The roster rule stays: it guards the seats
    // that never came through this grammar.
    if (isSecretary && seats.some((seat) => seat.isSecretary)) {
      throw new Error(`只能有一位秘书，「${name}」是第二个带 * 的。`);
    }
    seats.push({ seatId: `seat-${index + 1}`, displayName: name, role: role === "" ? "通用" : role, isSecretary });
  }
  if (seats.length === 0) throw new Error("至少要有一个席位。");
  return { displayName, projectFolder, seats };
}

/** `甲,乙: 指令` — an optional roll-call before the instruction. */
export interface SayInput {
  readonly instruction: string;
  /** Display names the host called on; empty means everyone. */
  readonly named: readonly string[];
}

import { parseMentions } from "./mention.ts";

/**
 * Read an optional roll-call off the front of an instruction.
 *
 * Decided against the ACTUAL roster, not by the shape of the text. Guessing
 * from shape was tried and fails on ordinary sentences: 「结论：我们用
 * Postgres」 has a short, space-free prefix and reads exactly like a
 * roll-call, so the first clause vanished and the instruction was addressed
 * to a seat named 结论. Whether a word is a seat's name is a fact this
 * console already has; there is no reason to infer it.
 */
export function parseSay(raw: string, seatNames: readonly string[] = []): SayInput {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("用法：/squad-say 指令   或   /squad-say 甲,乙: 指令");

  const at = trimmed.search(/[:：]/);
  if (at > 0) {
    const names = trimmed
      .slice(0, at)
      .split(/[,，、]/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const rest = trimmed.slice(at + 1).trim();
    if (rest !== "" && names.length > 0 && names.every((name) => seatNames.includes(name))) {
      return { instruction: rest, named: names };
    }
  }
  // Then `@`, which is what the panel uses and what 1.x used. The command had
  // only its own colon syntax, so the same sentence addressed one seat in the
  // box and the whole team on the command line — with nothing saying which
  // you had got.
  const mentioned = parseMentions(trimmed, seatNames);
  if (mentioned.named.length > 0) return { instruction: mentioned.instruction, named: [...mentioned.named] };
  return { instruction: trimmed, named: [] };
}

/** One complaint about a form field. */
export interface FieldProblem {
  readonly field: "displayName" | "projectFolder" | "roster";
  readonly detail: string;
}

/**
 * Check the three fields a panel collects, one at a time.
 *
 * `parseNewTeam` answers with the command's usage line, which is right for
 * the command and wrong for the form: a person who filled two boxes and
 * missed the third got a sentence reciting a slash-command grammar they never
 * typed, printed in red under all three. Same rules, tagged by field, so each
 * complaint can sit under the input that caused it.
 */
export function checkTeamFields(input: {
  readonly displayName?: string;
  readonly projectFolder?: string;
  readonly roster?: string;
}): readonly FieldProblem[] {
  const problems: FieldProblem[] = [];
  const displayName = (input.displayName ?? "").trim();
  const projectFolder = (input.projectFolder ?? "").trim();
  const roster = (input.roster ?? "").trim();

  if (displayName === "") problems.push({ field: "displayName", detail: "给团队起个名字。" });
  if (displayName.includes("|")) {
    // The three fields are joined with pipes to reach the shared grammar, so
    // a pipe typed into one of them would silently become a field boundary.
    problems.push({ field: "displayName", detail: "名字里不能有「|」。" });
  }
  if (projectFolder === "") problems.push({ field: "projectFolder", detail: "选一个项目文件夹。" });
  else if (!isAbsolutePath(projectFolder)) {
    problems.push({ field: "projectFolder", detail: `要绝对路径：「${projectFolder}」不是。` });
  }
  if (roster === "") problems.push({ field: "roster", detail: "至少要有一个席位。" });
  else {
    try {
      parseNewTeam([displayName || "占位", projectFolder || "/占位", roster].join(" | "));
    } catch (failure) {
      problems.push({ field: "roster", detail: String((failure as Error).message) });
    }
  }
  return problems;
}

/** One complaint about the panel's team form, which picks agents rather than typing them. */
export interface DraftProblem {
  readonly field: "displayName" | "projectFolder" | "members";
  readonly detail: string;
}

/**
 * Check the panel's team draft.
 *
 * Separate from `checkTeamFields` because the panel no longer types a roster:
 * it picks agents off the library, so the complaints are about the selection,
 * not about a grammar. The host still refuses — `checkRoster` is the
 * authority — this is only what lets each complaint sit under the control
 * that caused it.
 */
export function checkTeamDraft(input: {
  readonly displayName?: string;
  readonly projectFolder?: string;
  readonly members?: readonly { readonly templateId: string; readonly isSecretary?: boolean }[];
}): readonly DraftProblem[] {
  const problems: DraftProblem[] = [];
  const displayName = (input.displayName ?? "").trim();
  const projectFolder = (input.projectFolder ?? "").trim();
  const members = input.members ?? [];

  if (displayName === "") problems.push({ field: "displayName", detail: "给团队起个名字。" });
  if (projectFolder === "") problems.push({ field: "projectFolder", detail: "选一个项目文件夹。" });
  else if (!isAbsolutePath(projectFolder)) {
    problems.push({ field: "projectFolder", detail: `要绝对路径：「${projectFolder}」不是。` });
  }
  if (members.length === 0) problems.push({ field: "members", detail: "至少选一个 Agent。" });

  const secretaries = members.filter((member) => member.isSecretary === true);
  if (secretaries.length > 1) problems.push({ field: "members", detail: "只能有一位秘书。" });
  if (members.length > 0 && secretaries.length === 0) {
    // A warning shaped as a refusal, deliberately. A team with no secretary
    // has no seat that can plan an agenda, which is the thing teams exist
    // for — and nothing about the roster afterwards says that is why.
    problems.push({ field: "members", detail: "指一位秘书——只有秘书能排议程，不指的话这支团队开不了会。" });
  }
  return problems;
}
