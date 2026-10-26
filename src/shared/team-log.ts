/**
 * team-log.ts — the team log's vocabulary, as a closed list.
 *
 * New in Squad 3 (design doc §6.2). In 2.x the record was split in two:
 * speech went into dsh's session log, checkpoints into a storage domain,
 * because dsh's reader refuses event types it does not know. Here the log is
 * ours, so every team-level fact goes into ONE append-only file.
 *
 * Closed on purpose. An event type nobody handles is not skipped — reading it
 * fails, loudly. 2.x's checkpoint bug was exactly a reader that dropped what it
 * did not recognise: the history was cut at the checkpoint, the checkpoint
 * itself vanished, and nothing said so.
 *
 * Identity. Every line of the discussion has an `entryId`: a host message's is
 * its `commandId`, a reply and a system note get their own. Checkpoints cut at
 * an entry (`coversUpTo`), quotes point at one, and a continuing seat's window
 * starts after one — so "which line" must never be ambiguous.
 */
import type { SeatUsage } from "./seat-usage.ts";

interface Stamped {
  /** Position in this team's log, from 1, gapless. */
  readonly seq: number;
  /** Unix epoch milliseconds. */
  readonly at: number;
}

/** The host spoke: one command, addressed to the seats it names. */
export interface HostMessageEvent extends Stamped {
  readonly type: "host/message";
  /** Also this line's entry id. */
  readonly commandId: string;
  readonly text: string;
  /** The seats this command went to, resolved when it was sent. Never empty. */
  readonly seatIds: readonly string[];
  /** Earlier lines the host pointed at, by entry id. */
  readonly quoteIds: readonly string[];
  /** Documents attached to THIS command (pinned ones ride along without being listed here). */
  readonly materialIds?: readonly string[] | undefined;
  /**
   * Which documents the command actually carried, pinned ones included, as
   * the record shows it (`attachmentNote`). Part of the line: an answer that
   * leans on a document is unaccountable if the record does not say which
   * document was in front of it.
   */
  readonly attachments?: string | undefined;
  /**
   * Set when this line is a step of a confirmed agenda (the phase's title).
   * After a restart such a step is not an interrupted command to resend: the
   * agenda's own 「继续」 decides what runs again.
   */
  readonly agendaPhase?: string | undefined;
  /**
   * Set when the program wrote this message on the host's behalf — a
   * request whose wording lives in code (the plan shape for a redraft). Under
   * the host's name, but not the host's words: nothing may learn the host's
   * standards from it.
   */
  readonly sentFor?: ProgramRequest | undefined;
}

/** What the program asked for on the host's behalf. Closed, so the window can say it in either language. */
export type ProgramRequest = "plan-redraft";

/** A host message's line as the record reads it: the instruction, then what it carried. */
export function hostLineText(event: Pick<HostMessageEvent, "text" | "attachments">): string {
  return event.attachments === undefined ? event.text : `${event.text}\n${event.attachments}`;
}

/**
 * Exactly what one seat was handed for one command.
 *
 * The reason this event exists: 2.x could only RECONSTRUCT what a seat saw,
 * and reconstruction depends on assembly code not changing (2.x technical
 * design §10.10). Stored, it is a fact.
 */
export interface SeatRequestEvent extends Stamped {
  readonly type: "seat/request";
  readonly commandId: string;
  readonly seatId: string;
  readonly prompt: string;
  /** How many lines of earlier discussion the prompt carried. */
  readonly contextLines: number;
  /** The CLI conversation this turn continued, when it continued one. */
  readonly resumeId?: string | undefined;
}

/** What one seat answered — or why it did not. */
export interface SeatReplyEvent extends Stamped {
  readonly type: "seat/reply";
  readonly commandId: string;
  readonly entryId: string;
  readonly seatId: string;
  /** The seat's name at the time, so the record reads right after a rename. */
  readonly displayName: string;
  /** As recorded: cut-short replies carry their mark (see `cutShort`). */
  readonly text: string;
  /** Which command this answers, when commands overlapped (see `replyTag`). Empty otherwise. */
  readonly tag: string;
  readonly failed: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly usage?: SeatUsage | undefined;
}

/** Something the program itself says in the record: a stop, a withdrawal, a seat that left. */
export interface SystemNoteEvent extends Stamped {
  readonly type: "system/note";
  readonly entryId: string;
  readonly text: string;
}

/**
 * Lil X, deciding or answering in the host's place during an agenda the host
 * handed to it. A line of the discussion like any other — the seats read it,
 * which is how its answer reaches them — under a name nobody mistakes for the
 * host's.
 */
export interface ProxySaidEvent extends Stamped {
  readonly type: "proxy/said";
  readonly entryId: string;
  readonly text: string;
}

/** The host stopped a command. `withdrawn` when no seat had started on it. */
export interface CommandStoppedEvent extends Stamped {
  readonly type: "command/stopped";
  readonly commandId: string;
  readonly withdrawn: boolean;
}

/** The secretary folded the discussion up to `coversUpTo` into this text. */
export interface CheckpointRecordedEvent extends Stamped {
  readonly type: "checkpoint/recorded";
  readonly checkpointId: string;
  readonly text: string;
  /** Entry id of the last line this checkpoint summarised. */
  readonly coversUpTo: string;
}

/** The host retired a checkpoint. It stays in the log, readable; it stops standing in for anything. */
export interface CheckpointRevokedEvent extends Stamped {
  readonly type: "checkpoint/revoked";
  readonly checkpointId: string;
}

export type TeamLogEvent =
  | HostMessageEvent
  | SeatRequestEvent
  | SeatReplyEvent
  | SystemNoteEvent
  | ProxySaidEvent
  | CommandStoppedEvent
  | CheckpointRecordedEvent
  | CheckpointRevokedEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller writes; the log assigns `seq` and `at`. */
export type TeamLogEntry = DistributiveOmit<TeamLogEvent, "seq" | "at">;

export const TEAM_LOG_TYPES: readonly TeamLogEvent["type"][] = [
  "host/message",
  "seat/request",
  "seat/reply",
  "system/note",
  "proxy/said",
  "command/stopped",
  "checkpoint/recorded",
  "checkpoint/revoked",
];

export class UnknownLogEventError extends Error {}

/**
 * Check one parsed line against the vocabulary.
 *
 * Only the shape that later readers depend on is checked; a line that fails
 * names its position, so the person who has to repair the file knows where.
 */
export function asLogEvent(value: unknown, line: number): TeamLogEvent {
  if (typeof value !== "object" || value === null) {
    throw new UnknownLogEventError(`团队日志第 ${line} 行不是一个事件对象。`);
  }
  const record = value as Record<string, unknown>;
  if (!TEAM_LOG_TYPES.includes(record["type"] as TeamLogEvent["type"])) {
    throw new UnknownLogEventError(
      `团队日志第 ${line} 行的事件类型「${String(record["type"])}」不认识。` +
        `日志读不懂的部分不会被跳过——跳过会让后面的讨论悄悄少一截。`,
    );
  }
  if (typeof record["seq"] !== "number" || typeof record["at"] !== "number") {
    throw new UnknownLogEventError(`团队日志第 ${line} 行缺少 seq 或时间。`);
  }
  return value as TeamLogEvent;
}

/** The name Lil X speaks under, so nobody mistakes it for the host. */
export const proxySpeaker = (hostDisplayName: string): string => `Lil X（代${hostDisplayName}）`;

/** One line of the discussion as the context layer and quotes see it: who said what, under which id. */
export interface SpokenLine {
  readonly entryId: string;
  readonly speaker: string;
  /** Without the speaker prefix. */
  readonly text: string;
}

/**
 * The discussion lines in a log, in order. Requests, stops and checkpoints are
 * not lines anyone said. Every other type is listed, so a new one is a type error here.
 */
export function spokenLines(events: readonly TeamLogEvent[], hostDisplayName: string): readonly SpokenLine[] {
  return events.flatMap((event): SpokenLine[] => {
    switch (event.type) {
      case "host/message":
        return [{ entryId: event.commandId, speaker: hostDisplayName, text: hostLineText(event) }];
      case "seat/reply":
        return [{ entryId: event.entryId, speaker: event.displayName, text: `${event.tag}${event.text}` }];
      case "system/note":
        return [{ entryId: event.entryId, speaker: "系统", text: event.text }];
      case "proxy/said":
        return [{ entryId: event.entryId, speaker: proxySpeaker(hostDisplayName), text: event.text }];
      case "seat/request":
      case "command/stopped":
      case "checkpoint/recorded":
      case "checkpoint/revoked":
        return [];
    }
  });
}
