// 移植自 Squad 2.x packages/table/src/commands.ts @ 8dcb903
/**
 * commands.ts — the decisions behind running commands in parallel.
 *
 * Pure, and apart from the service, because these are the rules a person
 * relies on without seeing them: that two seats work at once, that one seat
 * takes its commands in the order they were sent, that a seat is never shown
 * the command it is about to answer as if it were discussion. The service
 * owns the processes and the record; this decides who goes next.
 */

/** Where one command stands for one seat it named. */
export type CommandSeatState = "queued" | "running" | "answered" | "failed" | "stopped";

/**
 * Where one command stands as a whole.
 *
 * `interrupted` is a command the process died under: it is not resumed by
 * itself, because work that restarts without being asked is work nobody
 * decided to do. The person can send it again.
 */
export type CommandState = "queued" | "running" | "done" | "stopped" | "interrupted";

/** The part of a command these rules read. */
export interface CommandSlot {
  readonly commandId: string;
  readonly state: CommandState;
  /** In the order they were named. */
  readonly seatIds: readonly string[];
  readonly seats: ReadonlyMap<string, CommandSeatState>;
}

/** A command still owed work by at least one seat. */
export function isOpen(command: { readonly state: CommandState }): boolean {
  return command.state === "queued" || command.state === "running";
}

/**
 * The seat turns that can start now, oldest command first.
 *
 * A seat takes the oldest command still waiting for it, and only when it is
 * not already answering one: its CLI conversation is continued turn after
 * turn, and two turns resuming one conversation at once would each miss the
 * other, with only one of them remembered afterwards. Different seats are
 * independent and start side by side.
 *
 * A seat is claimed by the first command that reaches it, busy or not, so a
 * later command can never overtake an earlier one on the same seat.
 */
export function startable(
  commands: readonly CommandSlot[],
  busy: ReadonlySet<string>,
): readonly { readonly commandId: string; readonly seatId: string }[] {
  const claimed = new Set(busy);
  const turns: { commandId: string; seatId: string }[] = [];
  for (const command of commands) {
    if (!isOpen(command)) continue;
    for (const seatId of command.seatIds) {
      if (command.seats.get(seatId) !== "queued" || claimed.has(seatId)) continue;
      claimed.add(seatId);
      turns.push({ commandId: command.commandId, seatId });
    }
  }
  return turns;
}

/**
 * The record entries a seat's window must leave out.
 *
 * The command it is answering, because that reaches the seat as this round's
 * instruction and finding it again in the discussion would be reading it
 * twice — and any later command still waiting for it, which it must not
 * start answering early.
 */
export function excludedFor(
  commands: readonly CommandSlot[],
  seatId: string,
  answering: string | undefined,
): readonly string[] {
  return commands
    .filter((command) => command.commandId === answering || (isOpen(command) && command.seats.get(seatId) === "queued"))
    .map((command) => command.commandId);
}

/** Whether no seat in this command is still waiting or running. */
export function settled(seats: ReadonlyMap<string, CommandSeatState>): boolean {
  for (const state of seats.values()) {
    if (state === "queued" || state === "running") return false;
  }
  return true;
}

/** The start of an instruction, on one line, for naming it in another line. */
export function excerpt(text: string, length = 20): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= length ? flat : `${flat.slice(0, length)}…`;
}

/**
 * Which command a reply answers, when that is no longer obvious.
 *
 * Only when another command was sent after this one. Until then the reply
 * follows its own command in the record, as every reply always did, and the
 * record reads exactly as it used to. Once commands overlap the record can
 * read 「指令一、指令二、A 的答复」, and both the person and the next seat
 * reading it need to know which instruction A was answering.
 *
 * @param latestSeq the sequence number of the newest command sent so far.
 */
export function replyTag(
  command: { readonly seq: number; readonly at: number; readonly instruction: string },
  latestSeq: number,
): string {
  if (command.seq === latestSeq) return "";
  const at = new Date(command.at);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `（答 ${clock}「${excerpt(command.instruction)}」）\n`;
}

/** What is appended to a reply that a stop cut short. */
export const CUT_SHORT_MARK = "（被叫停，未答完）";

/**
 * A reply as it goes into the record, when a stop interrupted it.
 *
 * A seat that is stopped a few seconds in has usually said something — 「我先
 * 读两份文档再评审。」 — and that opening line, recorded bare, reads as its
 * whole answer: a member who looked at the question and had one sentence to
 * offer. Marked, it reads as what it is. The next seat to read the record
 * needs that as much as the person does.
 *
 * Nothing to mark when the seat had said nothing; that case gets its own
 * line saying it was stopped.
 */
export function cutShort(text: string): string {
  return text.trim() === "" ? text : `${text.trimEnd()}\n\n${CUT_SHORT_MARK}`;
}

/** How much of a failure to quote where a whole reply would not fit. */
const WHY_CHARS = 120;

/**
 * The first thing a failed reply says, for a line that has room for one.
 *
 * A failed seat's text is its own explanation — the watchdog's verdict, the
 * CLI's refusal — and its opening line is the part that names the cause.
 */
export function firstLine(text: string): string {
  const lines = text
    .split("\n")
    .map((one) =>
      one
        .trim()
        .replace(/^⚠️\s*/, "")
        .trim(),
    )
    .filter((one) => one !== "");
  // A line that ends in a colon is announcing the cause, not giving it —
  // 「该席位没有给出答复：」 says nothing by itself. The line after it does.
  const line = lines.find((one, index) => !/[:：]$/.test(one) || index === lines.length - 1) ?? "没有给出原因";
  return line.length <= WHY_CHARS ? line : `${line.slice(0, WHY_CHARS)}…`;
}
