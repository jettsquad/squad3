/**
 * table — teams, their rosters, and running commands.
 *
 * 移植自 Squad 2.x packages/table/src/service.ts @ 8dcb903 的发言部分
 * （submit / pump / launch / runTurn / runSeat / cancel / resend / windowForSeat）。
 * 改动：
 * - 没有主持人节点：团队记录就是 3 自己的日志，席位会话按 (teamId, seatId) 记。
 * - 指令表从日志重建：重启后，一条没答完、也没被叫停的指令就是「中断」，可以重发——
 *   不会自己重新开始（没人决定过的活不该自己开始）。
 * - 名册操作（加、删、改连接与上限、重新关联、按模板同步）在这里，不再分在 console 的
 *   http.ts 里：2.x console/src/http.ts 的 createTeamFromMembers / addSeatFrom /
 *   patchSeat / relink / syncTeamsWithTemplate / disbandTeam。
 * - 连接在席位开跑那一刻向库现查（2.x liveConnection）；上限在开跑之前查（2.x capReached）。
 * - 尚未移植：议程（阶段 4）、材料与提示词片段（阶段 3）、项目说明文件的读取与精简（阶段 3）。
 *
 * Who speaks and when is decided HERE, by code, from the host's instruction.
 * No model ever chooses who speaks (design doc §12, invariant 4).
 */
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  addUsage,
  attachmentNote,
  blocksForSeat,
  capExceeded,
  checkMaterial,
  checkPromptSet,
  composeSeatPrompt,
  connectionMismatch,
  EMPTY_TEAM_PROMPTS,
  EMPTY_TOTALS,
  imagePathOfMaterial,
  materialsForRound,
  quotesFrom,
  stripReasoning,
  applyDecision,
  checkAgendaAgainstRoster,
  draftIdentityMatches,
  driftBetween,
  initialNodes,
  nodeIdOf,
  nodeOf,
  passedTitles,
  rewindTo,
  shortHash,
  standing,
  tally,
  phaseLedger,
  PROXY_DECISION_CAP,
  type AgendaPhase,
  type AgendaSpec,
  type Decision,
  type DecisionPoint,
  type ProxyDecision,
  type ProxyDecisionEntry,
  type ExitCheckResult,
  type NodeMap,
  type AgentTemplate,
  type Material,
  type PromptBlock,
  type Quote,
  type TeamPrompts,
  type SeatCaps,
  type SeatSpec,
  type UsageTotals,
} from "../../shared/index.ts";
import { parseMentions } from "../../shared/mention.ts";
import {
  hostLineText,
  type ProgramRequest,
  proxySpeaker,
  spokenLines,
  type SeatReplyEvent,
  type TeamLogEvent,
} from "../../shared/team-log.ts";
import type {
  CommandView,
  MethodInput,
  SeatInput,
  SeatSummary,
  TeamSummary,
  TranscriptLine,
} from "../../shared/wire.ts";
import type { TeamContext, TeamFacts } from "../context/index.ts";
import { DEFAULT_SECRETARY } from "../secretary/index.ts";
import {
  forgetSeatSession,
  forgetSeatSessions,
  rememberSeatSession,
  restoreSeatSessions,
  resumeWasRejected,
  seatSession,
  seatSessionId,
  snapshotSeatSessions,
  type SeatActivity,
  type SeatSession,
} from "../seat-runtime/index.ts";
import type { ResolvedConnection, Seats } from "../seats/index.ts";
import type { Store } from "../store/index.ts";
import {
  cutShort,
  excerpt,
  excludedFor,
  isOpen,
  replyTag,
  settled,
  startable,
  type CommandSeatState,
  type CommandState,
} from "./commands.ts";
import { outstandingWork } from "./agenda.ts";
import { agendaEnding, runAgendaNodes, unstopped, type AgendaPort } from "./agenda-runner.ts";
import { agendaEditIsLegal } from "./agenda-verdict.ts";
import { appendAudit, type AuditEntry, type AuditKind } from "./audit.ts";
import { runExitCheck } from "./check.ts";
import {
  judgeQuiet,
  quietLine,
  type QuietJudgement,
  type QuietJudgementInput,
  type QuietVerdict,
} from "./quiet-watch.ts";
import { agendaHash } from "./hash.ts";
import { renderDiscussion, writeDiscussion, writeReport } from "./export.ts";

export { writeReport } from "./export.ts";
export { CUT_SHORT_MARK, excerpt } from "./commands.ts";
export type { AuditEntry, AuditKind } from "./audit.ts";
import { projectMemoryFor } from "./project-memory.ts";
import { reopenReason } from "./reopen.ts";
import { checkRemoval, checkRoster as rosterProblems, placeSeat } from "./roster.ts";
import { planSeatSync, syncSeat, templateFacts } from "./seat-sync.ts";
import { groupIdOf, legacySittingBase, sessionLabel, sharedDiffers, sharedOf } from "./sessions.ts";

/** What `team.json` holds. */
export interface TeamRecord {
  readonly version: 2;
  readonly teamId: string;
  readonly displayName: string;
  readonly projectFolder: string;
  readonly hostDisplayName: string;
  readonly seats: readonly SeatSpec[];
  readonly createdAt: number;
  readonly usage: UsageTotals;
  readonly perSeat: Readonly<Record<string, UsageTotals>>;
  readonly checkpointCoefficient?: number | undefined;
  /** seatId → the CLI conversation it continues. Persisted so a restart does not force every seat fresh. */
  readonly seatSessions: Readonly<Record<string, SeatSession>>;
  /**
   * Background material, oldest first. On the team record, not the log: it is
   * what the team HOLDS, and removing a document must not rewrite what an
   * earlier command was recorded as carrying.
   */
  readonly materials?: readonly Material[] | undefined;
  /** The team's copies of shared prompt blocks, and who reads them (2.x `input.prompts`). */
  readonly prompts?: TeamPrompts | undefined;
  /** What was decided about this team, bounded (`audit.ts`). Not the discussion. */
  readonly audit?: readonly AuditEntry[] | undefined;
  /** Position in the team list, lowest first. Absent until someone arranges the list. */
  readonly order?: number | undefined;
  /**
   * An agenda the secretary drafted, waiting on the host. On the TEAM and on
   * disk: a decision waiting on a person must not disappear with a window or
   * a process (2.x 「生成的议程草案我也看不到」).
   */
  readonly draft?: AgendaDraftRecord | undefined;
  /** The agenda the host confirmed and where each node stands. Kept after it finishes, so a phase can be re-run. */
  readonly confirmed?: ConfirmedAgenda | undefined;
  /**
   * Set when the team was disbanded. The folder stays — the discussion
   * happened, and its checkpoints are the only account of what was decided —
   * but the table is gone: not listed, not loaded.
   */
  readonly disbandedAt?: number | undefined;
  /**
   * How it was archived: with its whole team, or on its own. Restoring a team
   * brings back the sessions archived with it, not ones put away before.
   * Absent on records archived before this existed, which count as "team".
   */
  readonly archivedAs?: "team" | "session" | undefined;
  /**
   * Set on a session opened from another: the team it belongs to (its first
   * session's id). The roster, folder, prompts, material, name and fold
   * threshold are held in common with it (`sessions.ts`).
   */
  readonly baseTeamId?: string | undefined;
  /** What the host called this session. Absent shows its number and start time. */
  readonly sessionName?: string | undefined;
}

/** One archived session, as the archive page lists it. */
export interface ArchivedSession {
  readonly teamId: string;
  readonly label: string;
  readonly archivedAt: number;
  readonly createdAt: number;
}

export interface ArchiveView {
  /** Teams with no session in use. */
  readonly teams: readonly {
    readonly teamId: string;
    readonly displayName: string;
    readonly projectFolder: string;
    readonly archivedAt: number;
    readonly sessions: readonly ArchivedSession[];
  }[];
  /** Sessions archived on their own, from teams still in use. */
  readonly sessions: readonly (ArchivedSession & { readonly teamName: string; readonly groupId: string })[];
}

/** A draft the secretary did not write, by where it came from. */
export type DraftAuthor = "plan-opening" | "designer-seed";

const DRAFT_AUTHORS: Record<DraftAuthor, string> = {
  "plan-opening": "团队方案（首场议程）",
  "designer-seed": "组队团队的种子议程",
};

export interface AgendaDraftRecord {
  readonly agenda: AgendaSpec;
  readonly at: number;
  /**
   * The team's plan identity, surviving re-drafts, and how many drafts there
   * have been. A confirmation names both, so a stale window cannot run a plan
   * that has since been replaced.
   */
  readonly agendaId: string;
  readonly revision: number;
  /** The secretary reply it was converted from, when it was. */
  readonly fromEntryId?: string | undefined;
  /**
   * Who wrote it, when it was not the secretary — a seed agenda the program
   * put up. Said on the card and in the audit: a plan attributed to the
   * secretary that the secretary never wrote is a false line in the record.
   */
  readonly author?: DraftAuthor | undefined;
  /**
   * The host's own standards that bear on this plan, one brief per labelled
   * phase. Shown BESIDE the draft, never recorded as a line: a line reaches
   * every seat's next window, and criteria shape how work is organised and
   * judged, never how a participant thinks.
   */
  readonly criteria?: readonly string[] | undefined;
}

export interface ConfirmedAgenda {
  readonly agenda: AgendaSpec;
  readonly at: number;
  /** Titles of the phases that passed — what older readers expect. */
  readonly done: readonly string[];
  readonly nodes: NodeMap;
  /** sha256 of the canonical agenda, so what ran stays checkable. */
  readonly hash: string;
  /** Who was at the table at confirmation; execution reads the current roster, this shows the difference. */
  readonly roster: readonly { readonly seatId: string; readonly displayName: string; readonly role: string }[];
  /** Confirmed 「由 Lil X 代理」: decision points go to the proxy, not the host. */
  readonly proxy?: boolean | undefined;
  /** What the proxy decided, oldest first: the raw material of the report. */
  readonly decisions?: readonly ProxyDecisionEntry[] | undefined;
  /** The project's HEAD when it started, for the report. */
  readonly startCommit?: string | undefined;
  /** Where the completion report was written, relative to the project. */
  readonly reportPath?: string | undefined;
}

/** What a stopped agenda leaves for whoever picks the work up (the secretary writes the hand-off from it). */
export interface AgendaTermination {
  readonly objective: string;
  readonly reason: string;
  readonly completed: readonly string[];
  readonly remaining: readonly string[];
  readonly artifacts: readonly string[];
  readonly discussion: readonly string[];
}

/** The agenda running right now, and the handle that stops it. */
interface RunningAgenda {
  readonly abort: AbortController;
  reason: string | undefined;
  progress: { readonly phase: string; readonly phaseIndex: number; readonly phaseCount: number };
  readonly completedPhases: string[];
  readonly completedTasks: string[];
  readonly artifacts: string[];
}

/** One instruction and where each seat it named stands. In memory; rebuilt from the log on start. */
interface Command {
  readonly commandId: string;
  readonly seq: number;
  /** The text as the host wrote it, roll-call included — that is what the record shows. */
  readonly text: string;
  /** What a seat is asked: the text with the leading roll-call removed. */
  readonly instruction: string;
  readonly at: number;
  readonly seatIds: readonly string[];
  readonly names: ReadonlyMap<string, string>;
  readonly quoteIds: readonly string[];
  readonly quotes: readonly Quote[];
  readonly materialIds: readonly string[];
  /**
   * Decided once for the whole command, so every seat in it sees the same
   * documents — two answers to one command from different evidence cannot
   * be compared.
   */
  readonly materials: readonly Material[];
  readonly abort: AbortController;
  readonly seats: Map<string, CommandSeatState>;
  state: CommandState;
  withdrawn: boolean;
  /** A step of the running agenda: stopping it stops the agenda, and it is never resent on its own. */
  readonly agendaPhase?: string | undefined;
}

/** Live state of one team, beside its record. */
interface Runtime {
  commands: Command[];
  readonly seatBusy: Set<string>;
  roundsInFlight: number;
  /** A fold is preparing fresh conversations; nothing starts until it is done. */
  preparing: boolean;
  /** seatId → last entry its window was taken against (for a continuing seat's tail). */
  readonly seenUpTo: Map<string, string>;
  /** seatId → what its stream says this turn: output so far, what is open, how long it has been quiet. */
  readonly working: Map<string, SeatActivity>;
  /** seatId → when its current turn started: an hour of tool work with no words must still read as an hour. */
  readonly turnStarted: Map<string, number>;
  /** seatId → what it is answering, for the status line. */
  readonly answering: Map<string, string>;
  /** seatId → the verdict on its quiet command this turn. */
  readonly quiet: Map<string, QuietVerdict>;
  /** Seats whose quiet command is being judged now: one judgement at a time per seat. */
  readonly judging: Set<string>;
  commandSeq: number;
  /** The agenda running now. While it runs, ordinary commands wait for it to end. */
  agenda: RunningAgenda | undefined;
  /** An agenda was confirmed while commands were running; it starts when they finish. */
  agendaWaiting: boolean;
  /** Called when the last running turn ends. */
  readonly idleWaiters: (() => void)[];
}

export interface Table {
  list(): { readonly teams: readonly TeamSummary[]; readonly problems: readonly string[] };
  create(input: MethodInput<"teams.create">): { readonly teamId: string };
  transcript(teamId: string): readonly TranscriptLine[];
  seatRequest(
    teamId: string,
    commandId: string,
    seatId: string,
  ): { readonly prompt: string; readonly contextLines: number };
  say(
    teamId: string,
    text: string,
    quoteIds?: readonly string[],
    materialIds?: readonly string[],
    /** Set when the program wrote this on the host's behalf. */
    sentFor?: ProgramRequest,
  ): { readonly commandId: string };
  /** Attach one document. Refused for the reasons `checkMaterial` names — never truncated. */
  addMaterial(
    teamId: string,
    material: { readonly name: string; readonly text: string },
  ): { readonly materialId: string };
  /** Pinned material rides along with every command. */
  setMaterialPinned(teamId: string, materialId: string, pinned: boolean): void;
  removeMaterial(teamId: string, materialId: string): void;
  cancel(teamId: string, commandId: string): void;
  resend(teamId: string, commandId: string): { readonly commandId: string };
  /** Stop every open command of this team. */
  stop(teamId: string): { readonly stopped: boolean };
  /** For the context layer. */
  facts(teamId: string): TeamFacts;
  /** A checkpoint landed or was revoked: every seat opens a fresh conversation next. */
  folded(teamId: string): void;
  /**
   * Take up a team written to disk while running (an import), the way a
   * restart would: the same checks, the same rebuild. Throws, naming why,
   * when it cannot be read — the import's read-back.
   */
  adopt(teamId: string): void;
  /**
   * Read a team's record and log from disk again, after something outside
   * the table added to them (an import topping up a session). Refused while
   * anything of it is running.
   */
  reload(teamId: string): void;
  /** Every command in flight, for shutdown. Settles when they have all stopped. */
  stopAll(): Promise<void>;

  rename(teamId: string, displayName: string): void;
  /**
   * A fresh discussion for the same team: same roster, folder, prompts and
   * material; its own record, usage, CLI conversations and agenda.
   */
  openSession(teamId: string, name?: string): { readonly teamId: string };
  /** Name one session (blank goes back to its number and start time). */
  renameSession(teamId: string, name: string): void;
  /** Archive one session. Refused for a team's last session. */
  closeSession(teamId: string): void;
  /**
   * What is archived: whole teams, and single sessions of teams still in use.
   * Read from disk at start and kept up to date.
   */
  archive(): ArchiveView;
  /** Bring back an archived team (with the sessions archived with it) or session. */
  restore(teamId: string): { readonly teamId: string };
  /**
   * Delete for good what is archived: a whole team, or one session. Only ever
   * from the archive, so it always takes two steps. Removes Squad's own
   * folder for it; nothing in the project folder is touched.
   */
  remove(teamId: string): void;
  /** The fold threshold as a fraction of the context window; `undefined` is the default. */
  setCoefficient(teamId: string, coefficient: number | undefined): void;
  /** Move a team up or down the list. */
  move(teamId: string, delta: number): void;
  /** Archive the team — every session of it; the records stay on disk. Refused while anything is running. */
  disband(teamId: string): void;
  addSeat(teamId: string, input: MethodInput<"seats.add">): { readonly seatId: string };
  removeSeat(teamId: string, seatId: string, options?: { readonly confirmSecretary?: boolean }): void;
  /** Change a seat's connection or caps in place. `connectionId: ""` means the host's own login. */
  patchSeat(
    teamId: string,
    seatId: string,
    patch: { readonly connectionId?: string | undefined; readonly caps?: SeatCaps | undefined },
  ): void;
  /** Point a seat at a library agent and take its settings. */
  relinkSeat(teamId: string, seatId: string, templateId: string): void;
  /**
   * Carry an edited agent into every team sitting it. Returns the teams that
   * could not take it now (mid-round), each with its reason; the next save
   * tries again.
   */
  syncTemplate(template: AgentTemplate): readonly string[];
  /**
   * Replace a team's shared prompts wholesale — blocks, the 全员 selection
   * and the sets — so the three can never half-apply. Refused only for
   * errors (a set naming something that does not exist); an empty set is the
   * normal state of one just created.
   */
  setPrompts(teamId: string, prompts: TeamPrompts): void;
  /** Append to this team's audit — for decisions made outside the table (a fold, a revoke). */
  note(teamId: string, kind: AuditKind, detail: string): void;
  /** A line in the record from the program itself. */
  recordNote(teamId: string, text: string): void;

  /**
   * Put a secretary's draft up for confirmation. Checked against the real
   * roster first: a hallucinated seat id survives parsing and at execution
   * looks exactly like a seat with nothing to say.
   */
  setDraft(
    teamId: string,
    agenda: AgendaSpec,
    options?: {
      /** The secretary reply it was converted from. */
      readonly fromEntryId?: string | undefined;
      readonly criteria?: readonly string[] | undefined;
      /** Who wrote it, when not the secretary (the program putting up a seed agenda). */
      readonly author?: DraftAuthor | undefined;
    },
  ): { readonly agendaId: string; readonly revision: number };
  /**
   * The host's verdict on the standing draft. `agenda` is the host's edit of
   * it — never a plan nobody proposed. Confirming starts the run; it is not
   * awaited (an agenda is minutes of work).
   */
  resolveAgenda(
    teamId: string,
    verdict: {
      readonly kind: "confirm" | "discard";
      readonly agendaId?: string | undefined;
      readonly revision?: number | undefined;
      readonly agenda?: AgendaSpec | undefined;
      readonly proxy?: boolean | undefined;
    },
  ): void;
  /** Carry on an unfinished agenda. Never automatic. Not awaited. */
  resumeAgenda(teamId: string): void;
  /** Put the plan back to before phase `phaseIndex`. The discussion is not rewound, and nothing starts by itself. */
  rewindAgenda(teamId: string, phaseIndex: number): void;
  /** Choose what happens to a node the agenda stopped at; carries on when the choice leaves something to run. */
  decideNode(teamId: string, nodeId: string, decision: Decision): void;
  /** Give up the confirmed plan. Nothing said is removed. */
  abandonAgenda(teamId: string): void;
}

/**
 * What the table reads from the person's library. A narrow port rather than
 * the library itself: the table needs answers, not the power to edit.
 */
export interface TableLibrary {
  /** A library agent, live or soft-deleted. */
  template(templateId: string): AgentTemplate | undefined;
  /** Whether a connection with this id exists. */
  hasConnection(connectionId: string): { readonly backend: string; readonly displayName: string } | undefined;
  /** Looked up at each turn's start, key resolved. Throws when the connection is gone. */
  resolveConnection(connectionId: string): ResolvedConnection;
  /** What seats call the host. Copied into a team when it is created. */
  hostDisplayName(): string | undefined;
  /** A library prompt block, live or soft-deleted: to tell an edited team copy from an untouched one. */
  block?(blockId: string): PromptBlock | undefined;
}

export interface TableDeps {
  readonly store: Store;
  readonly seats: Seats;
  readonly context: TeamContext;
  readonly onChanged: (teamId: string) => void;
  /** Absent in tests that need no connections or agents. */
  readonly library?: TableLibrary | undefined;
  /**
   * The host stopped an agenda mid-run: here is what it leaves. The caller
   * has the secretary write the hand-off from it. Not called when Squad quits.
   */
  readonly onAgendaStopped?: ((teamId: string, termination: AgendaTermination) => void) | undefined;
  /**
   * Lil X deciding at a decision point, for agendas confirmed 「由 Lil X 代理」.
   * Throws when it could not answer usably; the agenda then stops for the
   * host, which is what would have happened without a proxy.
   */
  readonly proxy?: ((point: DecisionPoint, signal: AbortSignal) => Promise<ProxyDecision>) | undefined;
  /**
   * A round or an agenda run has ended: the moment someone who looked away
   * wants to hear about. Whether to interrupt them is the listener's call.
   */
  readonly onRoundEnded?: ((event: RoundEndedEvent) => void) | undefined;
  /**
   * The secretary's judgement on a quiet command. Absent, or a team with no
   * secretary, and the command goes straight to the host.
   */
  readonly judgeQuiet?:
    ((teamId: string, input: QuietJudgementInput, signal: AbortSignal) => Promise<QuietJudgement>) | undefined;
  /** A quiet command the secretary (or nobody) could not clear: the host should look. */
  readonly onQuietAsk?: ((event: QuietAskEvent) => void) | undefined;
  /** Runs a phase's exit check; injected so tests need no shell. */
  readonly runCheck?:
    | ((check: NonNullable<AgendaPhase["check"]>, cwd: string, signal: AbortSignal) => Promise<ExitCheckResult>)
    | undefined;
}

/**
 * A round, or an agenda run, has ended.
 *
 * 移植自 Squad 2.x packages/table/src/service.ts 的 RoundEndedEvent @ 8e96d9c.
 * Facts only: whether this is worth a banner, and whether anyone is looking,
 * is the listener's business — the table has no business knowing there is a screen.
 */
export interface RoundEndedEvent {
  readonly teamId: string;
  readonly teamName: string;
  readonly kind: "round" | "agenda";
  /** Cut short by 「叫停」 or an abort, rather than finished. */
  readonly stopped: boolean;
  /** How many seats answered, and how many of those answers were failures. */
  readonly answered: number;
  readonly failed: number;
  /** The last seat that answered properly, for a preview line. */
  readonly last?: { readonly speaker: string; readonly text: string } | undefined;
  /** Another command is already queued and starting — this is not a stopping point. */
  readonly moreQueued: boolean;
  /** An agenda handed control back to the host and is waiting for them. */
  readonly waitingForHost: boolean;
}

/** A quiet command put in front of the host. */
export interface QuietAskEvent {
  readonly teamId: string;
  readonly teamName: string;
  readonly seat: string;
  readonly reason: string;
}

/**
 * What a working seat is doing and whether it has gone quiet, in words.
 *
 * The open command is what makes a long silence readable: a test suite that
 * has been running for twelve minutes and a seat wedged on a dead endpoint are
 * both silent, and only one of them is fine.
 */
function doingOf(activity: SeatActivity | undefined, verdict?: QuietVerdict): { doing?: string; quiet?: string } {
  if (activity === undefined) return {};
  const open = activity.open[0];
  const doing =
    open === undefined
      ? undefined
      : `${open.background ? "后台" : ""}${open.tool}：${open.command}` +
        (activity.open.length > 1 ? `（另有 ${activity.open.length - 1} 项）` : "");
  const quiet =
    activity.quietForMs === undefined
      ? undefined
      : `已经 ${Math.round(activity.quietForMs / 60_000)} 分钟没有新输出，但它的命令还没跑完，所以没有中止。` +
        (verdict === undefined
          ? ""
          : `${verdict.by === "secretary" ? "秘书" : "系统"}判断：${verdict.verdict === "wait" ? "继续等" : "请你看一眼"}——${verdict.reason}`);
  return { ...(doing === undefined ? {} : { doing }), ...(quiet === undefined ? {} : { quiet }) };
}

/**
 * How many sub-agents a seat has running: its open calls to Claude Code's
 * `Agent` (formerly `Task`) tool. Eight of them fetching standards for an hour
 * produce no words at all, and the window must be able to say why.
 */
export function subagentsOf(activity: SeatActivity | undefined): number {
  return (activity?.open ?? []).filter((command) => command.tool === "Agent" || command.tool === "Task").length;
}

/** A copy the wire's mutable arrays accept. */
const promptsView = (prompts: TeamPrompts): TeamSummary["prompts"] => ({
  blocks: prompts.blocks.map((block) => ({ ...block })),
  teamBlockIds: [...prompts.teamBlockIds],
  sets: prompts.sets.map((set) => ({ ...set, blockIds: [...set.blockIds], seatIds: [...set.seatIds] })),
});

/** How many of the newest audit entries the window gets; the rest stay in team.json. */
const AUDIT_SHOWN = 60;

/** The discussion line an event is, when it is one. */
const entryIdOf = (event: TeamLogEvent): string | undefined =>
  event.type === "host/message"
    ? event.commandId
    : event.type === "seat/reply" || event.type === "system/note" || event.type === "proxy/said"
      ? event.entryId
      : undefined;

const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/**
 * The folder a team works in, checked and made canonical. Checked because
 * every seat starts there; canonical because 2.x found one folder spelled two
 * ways becoming two places (2.x §8.2).
 */
function canonicalFolder(path: string): string {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`项目文件夹「${path}」不存在。`);
  }
  if (!stat.isDirectory()) throw new Error(`「${path}」不是文件夹。`);
  return realpathSync.native(path);
}

/** Roster rules, checked on the roster as it will be saved. Thrown with every problem's own sentence. */
function checkRoster(seats: readonly SeatSpec[]): void {
  // Two seats with one name are indistinguishable everywhere a name is the
  // address: `@` mentions, the record's 【名字】 prefix, a continuing tail.
  if (seats.some((seat) => seat.displayName.trim() === "")) throw new Error("每个席位都要有名字。");
  const twice = seats.find((seat, at) => seats.findIndex((other) => other.displayName === seat.displayName) !== at);
  if (twice !== undefined) throw new Error(`两个席位都叫「${twice.displayName}」。名字是点名用的，不能重复。`);
  const problems = rosterProblems(seats);
  if (problems.length > 0) throw new Error(problems.map((problem) => problem.detail).join("\n"));
}

function seatFromInput(input: SeatInput, seatId: string): SeatSpec {
  return {
    seatId,
    displayName: input.displayName.trim(),
    role: input.role.trim(),
    systemPrompt: input.systemPrompt,
    backend: input.backend,
    ...(input.isSecretary === true ? { isSecretary: true } : {}),
  };
}

/**
 * A seat copied from a library agent. Everything that decides how it is
 * dispatched comes from the template; whether it is the secretary is a fact
 * about this team.
 */
function seatFromTemplate(template: AgentTemplate, seatId: string, isSecretary: boolean): SeatSpec {
  // The template's own answer to "may this be a secretary" is a refusal, not
  // a default that gets overwritten: an agent whose instructions never
  // mentioned planning an agenda should not become the seat that plans one
  // because a checkbox was ticked on the other screen.
  if (isSecretary && !template.secretaryCandidate) {
    throw new Error(`「${template.displayName}」在 Agent 库里没有勾选「可以当秘书」。`);
  }
  return syncSeat<SeatSpec>(
    {
      seatId,
      displayName: template.displayName,
      role: template.role,
      systemPrompt: template.systemPrompt,
      backend: template.backend,
      templateId: template.templateId,
      ...(isSecretary ? { isSecretary: true } : {}),
    },
    templateFacts(template),
  );
}

/**
 * Whether this seat has reached a limit it was given.
 *
 * Checked BEFORE the child starts. Checking afterwards would report a limit
 * as reached by the very turn that spent past it — which is the one turn a
 * limit exists to prevent. Cache tokens count: they are billed, and a limit
 * that ignored them would let a seat spend six figures while reporting four.
 */
function capReached(
  seat: SeatSpec,
  used: UsageTotals,
  mode: "subscription" | "api-key" | undefined,
): string | undefined {
  if (seat.caps === undefined) return undefined;
  return capExceeded(
    seat.caps,
    {
      turns: used.turns,
      tokens: used.inputTokens + used.outputTokens + used.cacheReadTokens + used.cacheCreationTokens,
      ...(used.costUsd === undefined ? {} : { costUsd: used.costUsd }),
    },
    // A seat naming no connection runs on the host's own CLI login, which is
    // a subscription: it bills nothing, so cost ceilings do not apply to it.
    mode ?? "subscription",
  );
}

export function createTable(deps: TableDeps): Table {
  const { store, seats: adapters, context, onChanged } = deps;
  const loaded = store.loadTeams<TeamRecord>();
  const problems = [...loaded.problems];
  const teams = new Map<string, TeamRecord>();
  const runtimes = new Map<string, Runtime>();
  /** Archived records, by id: on disk, not on the table. */
  const archived = new Map<string, TeamRecord>();
  /** Set by `stopAll`. A seat killed because Squad is quitting is not a stop anyone made. */
  let quitting = false;

  const teamOf = (teamId: string): TeamRecord => {
    const team = teams.get(teamId);
    if (team === undefined) throw new Error(`没有这支团队：${teamId}`);
    return team;
  };
  const runtimeOf = (teamId: string): Runtime => {
    const runtime = runtimes.get(teamId);
    if (runtime === undefined) throw new Error(`没有这支团队：${teamId}`);
    return runtime;
  };
  const logOf = (teamId: string) => store.logFor(teamId);

  /** Every live session of the team this one belongs to, itself included. */
  const sessionsOf = (team: TeamRecord): TeamRecord[] =>
    [...teams.values()].filter((other) => groupIdOf(other) === groupIdOf(team));

  /**
   * Write a record — and carry what a team holds in common (roster, folder,
   * prompts, material, name, fold threshold) to its other sessions. Every
   * write goes through here, so no session can drift into a different team.
   */
  const save = (team: TeamRecord): void => {
    teams.set(team.teamId, team);
    store.saveTeam(team.teamId, team);
    for (const other of sessionsOf(team)) {
      if (other.teamId === team.teamId) continue;
      const differs = sharedDiffers(other, team);
      const carried: TeamRecord = { ...other, ...sharedOf(team) };
      // Equal or not, the session now holds the same objects, so the next
      // comparison is by reference.
      teams.set(other.teamId, carried);
      if (!differs) continue;
      store.saveTeam(other.teamId, carried);
      onChanged(other.teamId);
    }
  };
  /** Re-read the record and write it back with a change, so concurrent seats never overwrite each other's usage. */
  const update = (teamId: string, change: (team: TeamRecord) => TeamRecord): void => save(change(teamOf(teamId)));
  const saveSessions = (teamId: string): void =>
    update(teamId, (team) => ({ ...team, seatSessions: snapshotSeatSessions(teamId) }));

  /** Off the table and into the archive. The record is already written with `disbandedAt`. */
  const putAway = (teamId: string): void => {
    archived.set(teamId, teamOf(teamId));
    teams.delete(teamId);
    runtimes.delete(teamId);
    forgetSeatSessions(teamId);
  };

  const note = (teamId: string, kind: AuditKind, detail: string): void =>
    update(teamId, (team) => ({ ...team, audit: appendAudit(team.audit ?? [], { at: Date.now(), kind, detail }) }));

  /** teamId → its export in flight, so two never write one file at once. */
  const exports = new Map<string, Promise<void>>();
  /**
   * Refresh the readable copy of this discussion in its project folder
   * (`.squad/discussions/<teamId>.md`). Never awaited and never fatal: a full
   * disk or a read-only mount in somebody else's folder must not cost a round
   * its answer.
   */
  const exportRecord = (teamId: string): void => {
    const team = teams.get(teamId);
    if (team === undefined) return;
    const lines = spokenLines(logOf(teamId).read(), team.hostDisplayName);
    if (lines.length === 0) return;
    const at = new Map(
      logOf(teamId)
        .read()
        .map((event) => [entryIdOf(event), event.at]),
    );
    const markdown = renderDiscussion({
      teamName: team.displayName,
      teamId,
      events: lines.map((line) => ({
        kind: "user/message",
        text: `【${line.speaker}】${line.text}`,
        at: at.get(line.entryId) ?? Date.now(),
      })),
      exportedAt: Date.now(),
    });
    const next = (exports.get(teamId) ?? Promise.resolve())
      .then(() => writeDiscussion(team.projectFolder, teamId, markdown))
      .catch((error: unknown) => {
        console.warn(
          `团队 ${teamId}：讨论副本没能写进 ${team.projectFolder}：${error instanceof Error ? error.message : String(error)}`,
        );
      });
    exports.set(teamId, next);
  };

  const libraryOf = (): TableLibrary => {
    if (deps.library === undefined) throw new Error("没有 Agent 库。");
    return deps.library;
  };
  const connectionOf = (seat: SeatSpec): ResolvedConnection | undefined => {
    const connectionId = (seat.connectionId ?? "").trim();
    if (connectionId === "") return undefined;
    return libraryOf().resolveConnection(connectionId);
  };
  const templateOf = (templateId: string): AgentTemplate => {
    const template = libraryOf().template(templateId);
    if (template === undefined) throw new Error(`Agent 库里没有这个模板：${templateId}。`);
    return template;
  };
  /**
   * Refused at the edit, where it can still be fixed cheaply: left to run
   * time, a missing or mismatched connection fails the first round with a
   * message about something nobody typed.
   */
  const checkConnectionFor = (backend: string, connectionId: string | undefined): void => {
    const id = (connectionId ?? "").trim();
    if (id === "") return;
    const found = libraryOf().hasConnection(id);
    if (found === undefined) throw new Error(`没有这个连接：${id}。`);
    const mismatch = connectionMismatch(backend, found.backend, found.displayName);
    if (mismatch !== undefined) throw new Error(mismatch);
  };
  const hostName = (): string => {
    const name = (deps.library?.hostDisplayName() ?? "").trim();
    return name === "" ? "主持人" : name;
  };
  /**
   * Teams in the order the list shows them, each followed by its other
   * sessions oldest first. A team is placed by its first session: arranged
   * ones by position, the rest by age.
   */
  const ordered = (): TeamRecord[] => {
    const groups = new Map<string, TeamRecord[]>();
    for (const team of teams.values()) {
      const group = groups.get(groupIdOf(team)) ?? [];
      group.push(team);
      groups.set(groupIdOf(team), group);
    }
    const leads = [...groups.values()].map((group) => group.sort((a, b) => a.createdAt - b.createdAt));
    leads.sort((a, b) => {
      const [x, y] = [a[0], b[0]];
      if (x === undefined || y === undefined) return 0;
      return (x.order ?? Number.MAX_SAFE_INTEGER) - (y.order ?? Number.MAX_SAFE_INTEGER) || x.createdAt - y.createdAt;
    });
    return leads.flat();
  };
  /** Whether anything is running in any session of this team: a shared edit must wait for all of them. */
  const groupBusy = (teamId: string): boolean =>
    sessionsOf(teamOf(teamId)).some((one) => {
      const runtime = runtimes.get(one.teamId);
      return runtime !== undefined && (runtime.roundsInFlight > 0 || runtime.preparing);
    });
  /** A fresh seat id. Minted here, never accepted from a caller: two seats sharing one are one seat in every later reading. */
  const newSeatId = (): string => newId("seat");

  /**
   * Replace the roster. Refused while a turn is running: its windows were
   * already taken, so a member arriving or leaving mid-round would either be
   * skipped or handed a window nobody else got.
   */
  const setRoster = (teamId: string, seats: readonly SeatSpec[]): void => {
    const runtime = runtimeOf(teamId);
    if (runtime.roundsInFlight > 0 || runtime.preparing) throw new Error("这一轮还在跑，等它结束再改名册。");
    // The roster is the team's, so every session of it must be between rounds.
    if (groupBusy(teamId)) throw new Error("这支团队的另一场会话还在跑，等它结束再改名册。");
    checkRoster(seats);
    update(teamId, (team) => ({ ...team, seats: [...seats] }));
    onChanged(teamId);
  };
  /** Swap one seat for its edited self AT ITS OLD INDEX: roster order is speaking order. */
  const replaceSeat = (teamId: string, next: SeatSpec): void => {
    const seats = teamOf(teamId).seats;
    const at = seats.findIndex((seat) => seat.seatId === next.seatId);
    if (at < 0) throw new Error(`这支团队里没有席位 ${next.seatId}。`);
    setRoster(
      teamId,
      placeSeat(
        seats.filter((seat) => seat.seatId !== next.seatId),
        next,
        at,
      ),
    );
  };

  // ── views ──────────────────────────────────────────────────────────────
  /** The draft waiting on the host, the confirmed plan and where each node stands, and what is running. */
  const agendaView = (team: TeamRecord, runtime: Runtime): TeamSummary["agenda"] => {
    const draft = team.draft;
    const held = team.confirmed;
    const roster = team.seats.map((seat) => seat.seatId);
    return {
      ...(draft === undefined
        ? {}
        : {
            draft: {
              agenda: draft.agenda,
              agendaId: draft.agendaId,
              revision: draft.revision,
              at: draft.at,
              ...(draft.fromEntryId === undefined ? {} : { fromEntryId: draft.fromEntryId }),
              ...(draft.author === undefined ? {} : { author: draft.author }),
              criteria: [...(draft.criteria ?? [])],
              // Rechecked against the roster as it is NOW: a member who left
              // since the draft was written is a task nobody can run.
              problems: checkAgendaAgainstRoster(draft.agenda, roster).map(
                (problem) => `「${problem.phase}」：${problem.detail}`,
              ),
            },
          }),
      ...(held === undefined
        ? {}
        : {
            confirmed: {
              agenda: held.agenda,
              at: held.at,
              hash: shortHash(held.hash),
              proxy: held.proxy === true,
              standing: standing(held.agenda, held.nodes),
              nodes: held.agenda.phases.map((phase, index) => {
                const node = nodeOf(held.nodes, nodeIdOf(phase, index));
                return {
                  nodeId: nodeIdOf(phase, index),
                  title: phase.title,
                  state: node.state,
                  attempts: node.attempts,
                  ...(node.why === undefined ? {} : { why: node.why }),
                  ...(node.lastCheck === undefined ? {} : { lastCheck: { ...node.lastCheck } }),
                  ...(phase.check === undefined ? {} : { check: phase.check.command }),
                };
              }),
              // Named, not counted: 「名册变了」 is not something a person can act on.
              drift: [...driftBetween(held.roster, team.seats)],
              decisions: (held.decisions ?? []).map((one) => ({
                at: one.at,
                title: one.title,
                problem: one.problem,
                detail: one.detail,
              })),
              ...(held.reportPath === undefined ? {} : { reportPath: held.reportPath }),
            },
          }),
      ...(runtime.agenda === undefined ? {} : { running: { ...runtime.agenda.progress } }),
      ...(runtime.agendaWaiting ? { waiting: true } : {}),
    };
  };
  /** How a seat is configured, and what is wrong with that, for the roster. */
  const seatConfig = (seat: SeatSpec): Partial<SeatSummary> => {
    const connectionId = (seat.connectionId ?? "").trim();
    const found = connectionId === "" ? undefined : deps.library?.hasConnection(connectionId);
    const templateGone =
      seat.templateId !== undefined &&
      deps.library !== undefined &&
      deps.library.template(seat.templateId) === undefined;
    const problem =
      connectionId !== "" && found === undefined
        ? `它用的连接「${connectionId}」已经不在了。到席位设置里换一个连接，或者改回本机登录。`
        : templateGone
          ? "它来自的 Agent 已经不在库里了。可以重新关联到库里的另一个 Agent。"
          : undefined;
    return {
      ...(seat.templateId === undefined ? {} : { templateId: seat.templateId }),
      ...(connectionId === "" ? {} : { connectionId }),
      ...(found === undefined ? {} : { connectionName: found.displayName }),
      ...(seat.permissionMode === undefined ? {} : { permissionMode: seat.permissionMode }),
      ...(seat.reasoningEffort === undefined ? {} : { reasoningEffort: seat.reasoningEffort }),
      ...(seat.caps === undefined ? {} : { caps: seat.caps }),
      ...(seat.color === undefined ? {} : { color: seat.color }),
      ...(seat.voiceId === undefined ? {} : { voiceId: seat.voiceId }),
      ...(problem === undefined ? {} : { problem }),
    };
  };
  const commandView = (command: Command): CommandView => ({
    commandId: command.commandId,
    excerpt: excerpt(command.text, 30),
    state: command.state,
    seats: command.seatIds.map((seatId) => ({
      seatId,
      displayName: command.names.get(seatId) ?? seatId,
      state: command.seats.get(seatId) ?? "queued",
    })),
  });

  const summary = (team: TeamRecord): TeamSummary => {
    const runtime = runtimeOf(team.teamId);
    const sessions = sessionsOf(team);
    return {
      teamId: team.teamId,
      displayName: team.displayName,
      groupId: groupIdOf(team),
      // Numbered among archived sessions too, so archiving 第 2 场 does not renumber 第 3 场.
      sessionLabel: sessionLabel(team, [
        ...sessions,
        ...[...archived.values()].filter((one) => groupIdOf(one) === groupIdOf(team)),
      ]),
      sessionCount: sessions.length,
      ...(team.sessionName === undefined || team.sessionName.trim() === "" ? {} : { sessionName: team.sessionName }),
      createdAt: team.createdAt,
      projectFolder: team.projectFolder,
      hostDisplayName: team.hostDisplayName,
      seats: team.seats.map((seat) => ({
        seatId: seat.seatId,
        displayName: seat.displayName,
        role: seat.role,
        backend: seat.backend,
        isSecretary: seat.isSecretary === true,
        working: runtime.seatBusy.has(seat.seatId),
        received: runtime.working.get(seat.seatId)?.received ?? 0,
        ...doingOf(runtime.working.get(seat.seatId), runtime.quiet.get(seat.seatId)),
        ...(runtime.turnStarted.has(seat.seatId) ? { startedAt: runtime.turnStarted.get(seat.seatId) } : {}),
        subagents: subagentsOf(runtime.working.get(seat.seatId)),
        ...(runtime.answering.has(seat.seatId) ? { answering: runtime.answering.get(seat.seatId) } : {}),
        queued: runtime.commands.filter((command) => isOpen(command) && command.seats.get(seat.seatId) === "queued")
          .length,
        continuing: seatSessionId(team.teamId, seat.seatId) !== undefined,
        usage: team.perSeat[seat.seatId] ?? EMPTY_TOTALS,
        ...seatConfig(seat),
      })),
      busy: runtime.roundsInFlight > 0 || runtime.preparing || runtime.agenda !== undefined,
      usage: team.usage,
      prompts: promptsView(team.prompts ?? EMPTY_TEAM_PROMPTS),
      agenda: agendaView(team, runtime),
      audit: (team.audit ?? []).slice(-AUDIT_SHOWN).map((entry) => ({ ...entry })),
      ...(team.checkpointCoefficient === undefined ? {} : { checkpointCoefficient: team.checkpointCoefficient }),
      materials: (team.materials ?? []).map((material) => {
        const imagePath = imagePathOfMaterial(material.text);
        return {
          materialId: material.materialId,
          name: material.name,
          chars: material.text.length,
          pinned: material.pinned === true,
          addedAt: material.addedAt,
          ...(imagePath === undefined ? {} : { imagePath }),
        };
      }),
      // A comparison, made fresh: a copy counts as edited when it differs from
      // the library entry it came from. One whose entry is gone is NOT edited
      // — there is nothing to differ from.
      editedBlockIds: (team.prompts?.blocks ?? [])
        .filter((block) => {
          const library = deps.library?.block?.(block.blockId);
          return library !== undefined && (library.text !== block.text || library.name !== block.name);
        })
        .map((block) => block.blockId),
      commands: runtime.commands
        .filter((command) => isOpen(command) || command.state === "interrupted")
        .map(commandView),
    };
  };

  // ── running ────────────────────────────────────────────────────────────
  /** Seat replies in the record that match, in order. */
  const repliesOf = (teamId: string, match: (event: SeatReplyEvent) => boolean): readonly SeatReplyEvent[] =>
    logOf(teamId)
      .read()
      .filter((event): event is SeatReplyEvent => event.type === "seat/reply" && match(event));

  /**
   * Tell the listener a round or an agenda run ended. A listener that throws
   * is logged and skipped: a notification that failed must never be the
   * reason a round's replies do not reach the person.
   */
  const emitRoundEnded = (
    teamId: string,
    kind: RoundEndedEvent["kind"],
    replies: readonly SeatReplyEvent[],
    stopped: boolean,
    waitingForHost: boolean,
  ): void => {
    if (deps.onRoundEnded === undefined || !teams.has(teamId)) return;
    const good = [...replies].reverse().find((reply) => !reply.failed && reply.text.trim() !== "");
    try {
      deps.onRoundEnded({
        teamId,
        teamName: teamOf(teamId).displayName,
        kind,
        stopped,
        answered: replies.length,
        failed: replies.filter((reply) => reply.failed).length,
        ...(good === undefined ? {} : { last: { speaker: good.displayName, text: good.text } }),
        // Another command still running or waiting is not a stopping point.
        moreQueued: runtimeOf(teamId).commands.some(isOpen),
        waitingForHost,
      });
    } catch (error) {
      console.warn(`round-ended 监听器抛错：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * A seat has gone a whole silence window with a command still open: ask the
   * secretary whether to keep waiting. Once per seat at a time; the verdict
   * goes on the seat's status, in the record and in the audit, and an 「ask」
   * is put in front of the host.
   */
  const watchQuiet = (teamId: string, seat: SeatSpec, task: string, activity: SeatActivity): void => {
    const runtime = runtimeOf(teamId);
    if (runtime.judging.has(seat.seatId) || activity.quietForMs === undefined) return;
    runtime.judging.add(seat.seatId);
    const quietForMs = activity.quietForMs;
    const team = teamOf(teamId);
    const secretary = team.seats.find((one) => one.isSecretary === true);
    const ask = deps.judgeQuiet;
    const nobody =
      secretary === undefined
        ? "这支团队没有秘书，所以直接请你看。"
        : secretary.seatId === seat.seatId
          ? "安静的正是秘书自己，所以直接请你看。"
          : "没有能做判断的秘书，所以直接请你看。";
    void judgeQuiet({
      seat: seat.displayName,
      task,
      open: activity.open,
      quietForMs,
      ...(activity.lastWords === undefined ? {} : { lastWords: activity.lastWords }),
      judge:
        ask === undefined || secretary === undefined || secretary.seatId === seat.seatId
          ? undefined
          : (input, signal) => ask(teamId, input, signal),
      nobody,
    })
      .then((verdict) => {
        if (!teams.has(teamId)) return;
        // Only while the seat is still on this turn: a verdict arriving after
        // it finished would sit on a seat that is no longer quiet.
        if (runtime.working.has(seat.seatId)) runtime.quiet.set(seat.seatId, verdict);
        const line = quietLine(seat.displayName, quietForMs, activity.open[0]?.command ?? "", verdict);
        logOf(teamId).append({ type: "system/note", entryId: newId("e"), text: line });
        note(teamId, "seat-quiet", line);
        if (verdict.verdict === "ask") {
          deps.onQuietAsk?.({ teamId, teamName: team.displayName, seat: seat.displayName, reason: verdict.reason });
        }
        onChanged(teamId);
      })
      .finally(() => runtime.judging.delete(seat.seatId));
  };

  const finishIfDone = (team: TeamRecord, command: Command): void => {
    if (!isOpen(command) || !settled(command.seats)) return;
    command.state = command.abort.signal.aborted ? "stopped" : "done";
    exportRecord(team.teamId);
    // An agenda's steps are commands too; the agenda reports once, when its run ends.
    if (command.agendaPhase === undefined) {
      const replies = repliesOf(team.teamId, (event) => event.commandId === command.commandId);
      emitRoundEnded(team.teamId, "round", replies, command.state === "stopped", false);
    }
    const runtime = runtimeOf(team.teamId);
    // The round-end signal goes out only when the whole team has gone quiet:
    // a fold with a seat still running would record a boundary mid-work.
    if (runtime.roundsInFlight === 0) context.roundEnded(team.teamId);
    onChanged(team.teamId);
  };

  /** Drop conversations no longer worth continuing (cold cache, oversized context). See reopen.ts. */
  const dropStaleSessions = (teamId: string, seats: readonly SeatSpec[]): void => {
    const now = Date.now();
    let dropped = false;
    for (const seat of seats) {
      if (reopenReason(seatSession(teamId, seat.seatId), now) === undefined) continue;
      forgetSeatSession(teamId, seat.seatId);
      dropped = true;
    }
    if (dropped) saveSessions(teamId);
  };

  /**
   * The window this seat gets, trimmed when it is continuing. Left out: the
   * command it is answering (it arrives as the instruction) and every later
   * one still queued for it (it must not start answering early).
   */
  const windowForSeat = (team: TeamRecord, seat: SeatSpec, answering?: string): readonly string[] => {
    const runtime = runtimeOf(team.teamId);
    const continuing = seatSessionId(team.teamId, seat.seatId) !== undefined;
    const exclude = excludedFor(runtime.commands, seat.seatId, answering);
    const seenUpTo = continuing ? runtime.seenUpTo.get(seat.seatId) : undefined;
    // Taken BEFORE the window: anything landing after this is what the next
    // continuing turn is handed.
    const last = spokenLines(logOf(team.teamId).read(), team.hostDisplayName).at(-1)?.entryId;
    const lines = context.windowFor(team.teamId, {
      ...(continuing ? { continuingAs: seat.displayName } : {}),
      ...(seenUpTo === undefined ? {} : { seenUpTo }),
      exclude,
    });
    if (last !== undefined) runtime.seenUpTo.set(seat.seatId, last);
    return lines;
  };

  /** The reply recorded, or `undefined` when Squad was quitting and recorded nothing. */
  const runSeat = async (
    teamId: string,
    command: Command,
    seat: SeatSpec,
    /** A snapshot taken at phase start, shared by every independent task of the phase. */
    preset?: readonly string[],
  ): Promise<SeatReplyEvent | undefined> => {
    const team = teamOf(teamId);
    const runtime = runtimeOf(teamId);
    const log = logOf(teamId);
    const adapter = adapters.adapterFor(seat.backend);
    if (typeof adapter === "string") throw new Error(adapter);
    // Looked up NOW, not when the team was built: an edited model or a rotated
    // key reaches this very turn. A connection that is gone throws, and the
    // turn fails saying so — never a quiet fall back to the host's login.
    const connection = connectionOf(seat);

    const reached = capReached(seat, team.perSeat[seat.seatId] ?? EMPTY_TOTALS, connection?.connection.authMode);
    if (reached !== undefined) {
      return log.append({
        type: "seat/reply",
        commandId: command.commandId,
        entryId: newId("e"),
        seatId: seat.seatId,
        displayName: seat.displayName,
        text: `⚠️ ${seat.displayName} ${reached}没有再交给它。要继续，到席位设置里调高上限。`,
        tag: replyTag(command, runtime.commandSeq),
        failed: true,
        cancelled: false,
        durationMs: 0,
      }) as SeatReplyEvent;
    }

    const memory = await projectMemoryFor(team.projectFolder, seat, (file, text) =>
      context.compactProjectMemory(teamId, file, text),
    );
    // Announced, not done quietly: creating a file in the person's project
    // folder is an automatic action with an invisible result.
    if (memory?.created === true) {
      log.append({
        type: "system/note",
        entryId: newId("e"),
        text: `已建立本项目的 ${memory.file} 最小模板；项目背景等待主持人确认，不自动搜索目录外的信息。`,
      });
    }

    const compose = (lines: readonly string[], continuing: boolean): string =>
      composeSeatPrompt({
        seat,
        instruction: command.instruction,
        context: lines,
        // Only to a FRESH conversation: a resumed one still carries the copy
        // it was handed, and resending it would pay for the project's notes
        // again every turn.
        ...(memory !== undefined && !continuing ? { projectMemory: { file: memory.file, text: memory.text } } : {}),
        // The live roster, read at turn time: a member added mid-discussion
        // should be someone the next round can hand work to.
        roster: team.seats,
        hostDisplayName: team.hostDisplayName,
        // Read from the record at turn time: an edit to the team's prompts
        // reaches the next turn of every seat.
        blocks: blocksForSeat(teamOf(teamId).prompts ?? EMPTY_TEAM_PROMPTS, seat.seatId),
        ...(command.quotes.length === 0 ? {} : { quotes: command.quotes }),
        ...(command.materials.length === 0 ? {} : { materials: command.materials }),
      });

    const attempt = async (lines: readonly string[]) => {
      const resumeId = adapter.capabilities.resume ? seatSessionId(teamId, seat.seatId) : undefined;
      const prompt = compose(lines, resumeId !== undefined);
      // Recorded BEFORE the seat starts: if the app dies mid-turn, the log
      // still says what the seat was handed.
      log.append({
        type: "seat/request",
        commandId: command.commandId,
        seatId: seat.seatId,
        prompt,
        contextLines: lines.length,
        ...(resumeId === undefined ? {} : { resumeId }),
      });
      const result = await adapter.start({
        seat,
        ...(connection === undefined ? {} : { connection }),
        cwd: team.projectFolder,
        prompt,
        ...(resumeId === undefined ? {} : { resumeId }),
        signal: command.abort.signal,
        onActivity: (activity) => {
          runtime.working.set(seat.seatId, activity);
          if (activity.quietForMs !== undefined) watchQuiet(teamId, seat, command.text, activity);
          onChanged(teamId);
        },
      }).result;
      return { result, resumeId, contextLines: lines.length };
    };

    let lines = preset ?? windowForSeat(team, seat, command.commandId);
    let turn = await attempt(lines);
    // A conversation the CLI no longer has is the one failure that running
    // again cures, so it is cured here rather than shown. The window is
    // REBUILT: a continuing seat was handed only what it had not seen, and a
    // fresh one must be handed everything.
    if (turn.result.failed && !turn.result.cancelled && resumeWasRejected(turn.resumeId, turn.result.text)) {
      forgetSeatSession(teamId, seat.seatId);
      runtime.seenUpTo.delete(seat.seatId);
      lines = windowForSeat(team, seat, command.commandId);
      turn = await attempt(lines);
    }
    const { result } = turn;
    // Squad is quitting and killed this seat. Nothing is recorded: nobody
    // stopped the command and the seat did not fail — the process died under
    // it. With no reply in the log, the restart finds the command
    // `interrupted` and the host decides whether to send it again (2.x
    // commands.ts). Recording a stop would take that choice away. The spend
    // is still counted: tokens burned before the kill cost what they cost.
    if (quitting) {
      update(teamId, (current) => ({ ...current, usage: addUsage(current.usage, result.usage) }));
      return undefined;
    }
    // A failed turn drops its conversation — an id kept after a failure makes
    // every later turn fail the same way; forgetting a good one costs one
    // un-resumed turn.
    if (result.failed) forgetSeatSession(teamId, seat.seatId);
    else if (result.sessionId !== undefined) {
      rememberSeatSession(teamId, seat.seatId, result.sessionId, {
        usedAt: Date.now(),
        contextTokens: result.usage?.contextTokens,
      });
    }

    const text = stripReasoning(result.text);
    // Stopped before it finished: what it had said so far is recorded as unfinished.
    const spoken = result.cancelled ? cutShort(text) : text;
    const reply = log.append({
      type: "seat/reply",
      commandId: command.commandId,
      entryId: newId("e"),
      seatId: seat.seatId,
      displayName: seat.displayName,
      text: spoken,
      tag: replyTag(command, runtime.commandSeq),
      failed: result.failed,
      cancelled: result.cancelled,
      durationMs: result.durationMs,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
    }) as SeatReplyEvent;
    if (result.cancelled && text.trim() === "") {
      // A cancelled seat SAYS it was cancelled. An empty failed reply reads as
      // "the model had nothing to say" — the one reading that sends a person
      // back to their prompt for a decision they made themselves.
      log.append({ type: "system/note", entryId: newId("e"), text: `⏹ ${seat.displayName} 被叫停，这一轮没有答复。` });
    }
    // Counted on failures too: a turn that burned tokens and then errored
    // still cost what it cost. Written after every turn, not at shutdown.
    update(teamId, (current) => ({
      ...current,
      usage: addUsage(current.usage, result.usage),
      perSeat: {
        ...current.perSeat,
        [seat.seatId]: addUsage(current.perSeat[seat.seatId] ?? EMPTY_TOTALS, result.usage),
      },
      seatSessions: snapshotSeatSessions(teamId),
    }));
    return reply;
  };

  const runTurn = async (teamId: string, command: Command, seat: SeatSpec): Promise<void> => {
    const runtime = runtimeOf(teamId);
    let state: CommandSeatState;
    try {
      const reply = await runSeat(teamId, command, seat);
      state = reply === undefined || reply.cancelled ? "stopped" : reply.failed ? "failed" : "answered";
    } catch (error) {
      if (quitting) return;
      // Whatever broke before or around the seat. Reported the same way: a
      // seat that quietly drops out of a command looks exactly like one that
      // had nothing to say.
      const detail = error instanceof Error ? error.message : String(error);
      try {
        logOf(teamId).append({
          type: "seat/reply",
          commandId: command.commandId,
          entryId: newId("e"),
          seatId: seat.seatId,
          displayName: seat.displayName,
          text: `⚠️ 该席位未能执行：${detail}`,
          tag: "",
          failed: true,
          cancelled: false,
          durationMs: 0,
        });
      } catch (logError) {
        console.error("团队日志写不进去：", logError, "原本的错误：", error);
      }
      state = "failed";
    } finally {
      runtime.seatBusy.delete(seat.seatId);
      runtime.working.delete(seat.seatId);
      runtime.turnStarted.delete(seat.seatId);
      runtime.answering.delete(seat.seatId);
      runtime.quiet.delete(seat.seatId);
      runtime.roundsInFlight -= 1;
    }
    command.seats.set(seat.seatId, state);
    finishIfDone(teamOf(teamId), command);
    // An agenda confirmed while commands ran starts when the last one ends.
    if (runtime.roundsInFlight === 0) for (const wake of runtime.idleWaiters.splice(0)) wake();
    pump(teamId);
    onChanged(teamId);
  };

  /** Mark one seat turn started — synchronously, so no second pump can take the seat. */
  const launch = (teamId: string, command: Command, seat: SeatSpec): void => {
    const runtime = runtimeOf(teamId);
    runtime.seatBusy.add(seat.seatId);
    runtime.working.set(seat.seatId, { received: 0, open: [] });
    runtime.turnStarted.set(seat.seatId, Date.now());
    runtime.answering.set(seat.seatId, excerpt(command.text, 40));
    command.seats.set(seat.seatId, "running");
    if (command.state === "queued") command.state = "running";
    runtime.roundsInFlight += 1;
    void runTurn(teamId, command, seat);
  };

  /**
   * Start every seat turn that can start now. A seat takes the oldest command
   * waiting for it and only when it is free (two turns resuming one
   * conversation would each miss the other); different seats run side by side.
   *
   * @param folded the pre-start fold already ran (or was tried) for this batch.
   */
  const pump = (teamId: string, folded = false): void => {
    const team = teams.get(teamId);
    const runtime = runtimes.get(teamId);
    if (team === undefined || runtime === undefined || runtime.preparing) return;
    // A command sent during an agenda waits for the whole agenda, not for the
    // phase it arrived in (2.x): the agenda is one stretch of work.
    if (runtime.agenda !== undefined || runtime.agendaWaiting) return;
    const batch: { readonly command: Command; readonly seat: SeatSpec }[] = [];
    for (const turn of startable(runtime.commands, runtime.seatBusy)) {
      const command = runtime.commands.find((candidate) => candidate.commandId === turn.commandId);
      if (command === undefined) continue;
      const seat = team.seats.find((candidate) => candidate.seatId === turn.seatId);
      if (seat === undefined) {
        logOf(teamId).append({
          type: "system/note",
          entryId: newId("e"),
          text: `⚠️ ${command.names.get(turn.seatId) ?? turn.seatId} 已经不在团队里，这条命令没有交给它。`,
        });
        command.seats.set(turn.seatId, "failed");
        finishIfDone(team, command);
        continue;
      }
      batch.push({ command, seat });
    }
    if (batch.length === 0) return;
    const seats = batch.map((entry) => entry.seat);
    dropStaleSessions(teamId, seats);
    // A fold discards every seat's conversation, so it may only run while
    // nothing is running — and it is the one chance to make a fresh
    // conversation start small. Everything in the batch waits for it.
    const fresh = seats.some((seat) => seatSessionId(teamId, seat.seatId) === undefined);
    if (!folded && fresh && runtime.roundsInFlight === 0) {
      runtime.preparing = true;
      onChanged(teamId);
      void context.beforeFreshStart(teamId).finally(() => {
        runtime.preparing = false;
        pump(teamId, true);
        onChanged(teamId);
      });
      return;
    }
    for (const { command, seat } of batch) launch(teamId, command, seat);
  };

  const newCommand = (
    team: TeamRecord,
    runtime: Runtime,
    input: {
      commandId: string;
      text: string;
      seatIds: readonly string[];
      quoteIds: readonly string[];
      materialIds: readonly string[];
      at: number;
    },
  ): Command => {
    const named = parseMentions(
      input.text,
      team.seats.map((seat) => seat.displayName),
    );
    runtime.commandSeq += 1;
    return {
      commandId: input.commandId,
      seq: runtime.commandSeq,
      text: input.text,
      instruction: named.instruction.trim() === "" ? input.text : named.instruction,
      at: input.at,
      seatIds: [...input.seatIds],
      names: new Map(
        input.seatIds.map((seatId) => [
          seatId,
          team.seats.find((seat) => seat.seatId === seatId)?.displayName ?? seatId,
        ]),
      ),
      quoteIds: [...input.quoteIds],
      quotes: quotesFrom(
        spokenLines(logOf(team.teamId).read(), team.hostDisplayName).map((line) => ({
          kind: "user/message",
          text: `【${line.speaker}】${line.text}`,
          turnId: line.entryId,
        })),
        input.quoteIds,
      ),
      materialIds: [...input.materialIds],
      materials: materialsForRound(team.materials ?? [], input.materialIds),
      abort: new AbortController(),
      seats: new Map(input.seatIds.map((seatId) => [seatId, "queued" as CommandSeatState])),
      state: "queued",
      withdrawn: false,
    };
  };

  /**
   * Rebuild the command table from the log. A command with a seat that never
   * answered and was never stopped was cut off by a restart: it is
   * `interrupted`, shown, and resent only if the host asks.
   */
  function rebuildRuntime(team: TeamRecord, events: readonly TeamLogEvent[]): Runtime {
    const runtime: Runtime = {
      commands: [],
      seatBusy: new Set(),
      roundsInFlight: 0,
      preparing: false,
      seenUpTo: new Map(),
      working: new Map(),
      turnStarted: new Map(),
      answering: new Map(),
      quiet: new Map(),
      judging: new Set(),
      commandSeq: 0,
      agenda: undefined,
      agendaWaiting: false,
      idleWaiters: [],
    };
    const byId = new Map<string, Command>();
    for (const event of events) {
      if (event.type === "host/message") {
        const base = newCommand(team, runtime, {
          commandId: event.commandId,
          text: event.text,
          seatIds: event.seatIds,
          quoteIds: event.quoteIds,
          materialIds: event.materialIds ?? [],
          at: event.at,
        });
        const command: Command = event.agendaPhase === undefined ? base : { ...base, agendaPhase: event.agendaPhase };
        byId.set(command.commandId, command);
        runtime.commands.push(command);
      } else if (event.type === "seat/reply") {
        byId
          .get(event.commandId)
          ?.seats.set(event.seatId, event.cancelled ? "stopped" : event.failed ? "failed" : "answered");
      } else if (event.type === "command/stopped") {
        const command = byId.get(event.commandId);
        if (command === undefined) continue;
        command.abort.abort();
        command.withdrawn = event.withdrawn;
        for (const [seatId, state] of command.seats) if (state === "queued") command.seats.set(seatId, "stopped");
      }
    }
    for (const command of runtime.commands) {
      // An agenda step cut off by a restart is not something to resend on its
      // own: the agenda's 「继续」 re-runs whatever did not pass.
      const cut = command.agendaPhase === undefined ? "interrupted" : "stopped";
      command.state = settled(command.seats) ? (command.abort.signal.aborted ? "stopped" : "done") : cut;
    }
    return runtime;
  }

  const submit = (
    teamId: string,
    text: string,
    seatIds: readonly string[],
    quoteIds: readonly string[],
    materialIds: readonly string[],
    sentFor?: ProgramRequest,
  ): { readonly commandId: string } => {
    const team = teamOf(teamId);
    const runtime = runtimeOf(teamId);
    const held = team.materials ?? [];
    const missing = materialIds.filter((id) => !held.some((material) => material.materialId === id));
    // Refused, not dropped: a command sent believing a document rode along,
    // answered by seats that never saw it, is the silent failure itself.
    if (missing.length > 0) throw new Error("附上的资料有的已经被移掉了，重新选一下再发。");
    const commandId = newId("c");
    const at = Date.now();
    const attachments = attachmentNote(materialsForRound(held, materialIds));
    logOf(teamId).append({
      type: "host/message",
      commandId,
      text,
      seatIds,
      quoteIds,
      ...(materialIds.length === 0 ? {} : { materialIds }),
      ...(attachments === undefined ? {} : { attachments }),
      ...(sentFor === undefined ? {} : { sentFor }),
    });
    runtime.commands.push(newCommand(team, runtime, { commandId, text, seatIds, quoteIds, materialIds, at }));
    pump(teamId);
    onChanged(teamId);
    return { commandId };
  };

  const cancel = (teamId: string, commandId: string): void => {
    const runtime = runtimeOf(teamId);
    const command = runtime.commands.find((candidate) => candidate.commandId === commandId);
    if (command === undefined) throw new Error("没有这条命令。");
    if (!isOpen(command)) throw new Error("这条命令已经结束了。");
    // A step of the running agenda is not stopped alone: what came after it
    // was planned on it, so stopping it is stopping the agenda.
    if (command.agendaPhase !== undefined && runtime.agenda !== undefined) {
      stopAgenda(teamId, `主持人叫停了「${command.agendaPhase}」这一步`);
      return;
    }
    // Already stopped and its seats are winding down: a second click must not
    // write a second line for the one stop.
    if (command.abort.signal.aborted) return;
    let started = false;
    for (const [seatId, state] of command.seats) {
      if (state === "queued") command.seats.set(seatId, "stopped");
      else started = true;
    }
    command.withdrawn = !started;
    command.abort.abort(new Error("已叫停"));
    const log = logOf(teamId);
    log.append({ type: "command/stopped", commandId, withdrawn: !started });
    log.append({
      type: "system/note",
      entryId: newId("e"),
      text: started ? `⏹ 主持人叫停了「${excerpt(command.text)}」` : `↩ 主持人撤回了「${excerpt(command.text)}」`,
    });
    // Ends here when nothing was running; otherwise the running seats end it.
    finishIfDone(teamOf(teamId), command);
    onChanged(teamId);
  };

  // ── agendas ────────────────────────────────────────────────────────────
  const persistConfirmed = (teamId: string, change: (held: ConfirmedAgenda) => ConfirmedAgenda): void =>
    update(teamId, (team) => (team.confirmed === undefined ? team : { ...team, confirmed: change(team.confirmed) }));

  /**
   * One seat, one agenda task, through the same path as any command: caps,
   * connection, project memory, blocks, the request and the reply in the log.
   * Never throws.
   */
  const agendaTurn = async (
    teamId: string,
    running: RunningAgenda,
    seat: SeatSpec,
    recorded: string,
    instruction: string,
    window: readonly string[] | undefined,
    phase: string,
    /**
     * The question is already in the record under someone else's name (Lil X
     * putting its proposal to the seats), so no host line is written for it.
     */
    silentHost = false,
  ): Promise<{ text: string; failed: boolean; cancelled: boolean }> => {
    const team = teamOf(teamId);
    const runtime = runtimeOf(teamId);
    const commandId = newId("c");
    if (!silentHost) {
      logOf(teamId).append({
        type: "host/message",
        commandId,
        text: recorded,
        seatIds: [seat.seatId],
        quoteIds: [],
        agendaPhase: phase,
      });
    }
    const base = newCommand(team, runtime, {
      commandId,
      text: recorded,
      seatIds: [seat.seatId],
      quoteIds: [],
      materialIds: [],
      at: Date.now(),
    });
    // The seat is asked the task with its footer; the record shows the line as written.
    const command: Command = { ...base, instruction, agendaPhase: phase };
    const stopTurn = (): void => command.abort.abort(running.abort.signal.reason);
    running.abort.signal.addEventListener("abort", stopTurn, { once: true });
    runtime.commands.push(command);
    runtime.seatBusy.add(seat.seatId);
    runtime.working.set(seat.seatId, { received: 0, open: [] });
    runtime.turnStarted.set(seat.seatId, Date.now());
    runtime.answering.set(seat.seatId, excerpt(recorded, 40));
    command.seats.set(seat.seatId, "running");
    command.state = "running";
    onChanged(teamId);
    let result: { text: string; failed: boolean; cancelled: boolean };
    try {
      const reply = await runSeat(teamId, command, seat, window);
      result =
        reply === undefined
          ? { text: "", failed: true, cancelled: true }
          : { text: reply.text, failed: reply.failed, cancelled: reply.cancelled };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const text = `⚠️ 该席位未能执行：${detail}`;
      if (!quitting) {
        logOf(teamId).append({
          type: "seat/reply",
          commandId,
          entryId: newId("e"),
          seatId: seat.seatId,
          displayName: seat.displayName,
          text,
          tag: "",
          failed: true,
          cancelled: false,
          durationMs: 0,
        });
      }
      result = { text, failed: true, cancelled: false };
    } finally {
      running.abort.signal.removeEventListener("abort", stopTurn);
      runtime.seatBusy.delete(seat.seatId);
      runtime.working.delete(seat.seatId);
      runtime.turnStarted.delete(seat.seatId);
      runtime.answering.delete(seat.seatId);
      runtime.quiet.delete(seat.seatId);
    }
    command.seats.set(seat.seatId, result.cancelled ? "stopped" : result.failed ? "failed" : "answered");
    command.state = result.cancelled ? "stopped" : "done";
    onChanged(teamId);
    return result;
  };

  /**
   * Run a confirmed agenda. Commands still running finish first, and nothing
   * new starts meanwhile; they are not stopped — confirming a plan is not
   * taking back what the host already sent.
   */
  const runAgenda = async (teamId: string, agenda: AgendaSpec, resuming: boolean, proxied: boolean): Promise<void> => {
    const runtime = runtimeOf(teamId);
    if (runtime.agenda !== undefined) throw new Error("这支团队已经在跑一个议程了。");
    if (runtime.roundsInFlight > 0) {
      if (runtime.agendaWaiting) throw new Error("已经有一个议程在等手上的命令答完了。");
      runtime.agendaWaiting = true;
      onChanged(teamId);
      try {
        await new Promise<void>((resolve) => runtime.idleWaiters.push(resolve));
      } finally {
        runtime.agendaWaiting = false;
      }
      if (quitting || !teams.has(teamId)) return;
    }
    const team = teamOf(teamId);
    // Where this run starts in the record: its replies are the ones after it.
    const startSeq = logOf(teamId).read().at(-1)?.seq ?? 0;
    // Written down BEFORE the first phase runs: a crash between confirmation
    // and the first turn must still leave the plan, and that it was confirmed.
    const hash = agendaHash(agenda);
    const held = team.confirmed;
    const nodes: NodeMap = resuming ? (held?.nodes ?? initialNodes(agenda, held?.done)) : initialNodes(agenda);
    const passedBefore = tally(agenda, nodes).passed;
    const proxy = resuming ? held?.proxy === true : proxied;
    update(teamId, (current) => ({
      ...current,
      confirmed: {
        agenda,
        at: held?.at ?? Date.now(),
        done: [...passedTitles(agenda, nodes)],
        nodes,
        hash,
        roster: current.seats.map((seat) => ({ seatId: seat.seatId, displayName: seat.displayName, role: seat.role })),
        ...(proxy ? { proxy: true } : {}),
        ...(resuming && held?.startCommit !== undefined ? { startCommit: held.startCommit } : {}),
      },
    }));
    note(
      teamId,
      resuming ? "agenda-resumed" : "agenda-confirmed",
      resuming
        ? `续跑，已通过 ${passedBefore} / ${agenda.phases.length} 个阶段。`
        : `主持人确认了议程，共 ${agenda.phases.length} 个阶段，名册 ${team.seats.length} 人${proxy ? "，由 Lil X 代理" : ""}。`,
    );
    if (resuming) {
      // Only nodes that PASSED are left alone, so one cut off halfway runs
      // again from the top — said, because an unexplained duplicate reads like a bug.
      logOf(teamId).append({
        type: "system/note",
        entryId: newId("e"),
        text: "▶ 议程继续。已通过的阶段不重跑；上次没有通过的那个阶段会从头再来一遍。",
      });
    }

    const running: RunningAgenda = {
      abort: new AbortController(),
      reason: undefined,
      progress: { phase: agenda.phases[0]?.title ?? "", phaseIndex: 1, phaseCount: agenda.phases.length },
      completedPhases: [],
      completedTasks: [],
      artifacts: [],
    };
    runtime.agenda = running;
    onChanged(teamId);
    // Before the team counts as busy: the fold this may run needs it idle,
    // and between phases it never is again until the agenda ends.
    dropStaleSessions(teamId, team.seats);
    await context.beforeFreshStart(teamId);
    runtime.roundsInFlight += 1;
    const check = deps.runCheck ?? ((spec, cwd, signal) => runExitCheck(spec, cwd, signal));
    let outcome: Awaited<ReturnType<typeof runAgendaNodes>> | undefined;
    try {
      // The project's HEAD before any of this ran, for the report. Best
      // effort: a folder that is not a repository just has no such line.
      if (!resuming) {
        const head = await check(
          { command: "git rev-parse HEAD", timeoutSec: 20 },
          team.projectFolder,
          running.abort.signal,
        );
        const commit = head.exitCode === 0 ? head.tail.trim().split("\n").at(-1) : undefined;
        if (commit !== undefined && commit !== "")
          persistConfirmed(teamId, (current) => ({ ...current, startCommit: commit }));
      }
      const said = (text: string): void => {
        logOf(teamId).append({ type: "proxy/said", entryId: newId("e"), text });
        onChanged(teamId);
      };
      /** Kept in the discussion, the audit, and for the report. */
      const recordDecision = (entry: Omit<ProxyDecisionEntry, "at">, line: string): void => {
        persistConfirmed(teamId, (current) => ({
          ...current,
          decisions: [...(current.decisions ?? []), { at: Date.now(), ...entry }],
        }));
        said(line);
        note(teamId, "agenda-decided", `Lil X 对「${entry.title}」：${unstopped(entry.detail)}。`);
      };
      const pointOf = (
        nodes: NodeMap,
        at: {
          readonly phase: AgendaPhase;
          readonly nodeId: string;
          readonly reason: DecisionPoint["reason"];
          readonly why: string;
          readonly lastReply: { readonly seat: string; readonly text: string } | undefined;
        },
        discussion?: DecisionPoint["discussion"],
      ): DecisionPoint => {
        const node = nodeOf(nodes, at.nodeId);
        const current = teamOf(teamId);
        return {
          nodeId: at.nodeId,
          phase: at.phase,
          reason: at.reason,
          why: at.why,
          attempts: node.attempts,
          decisions: node.decisions ?? 0,
          ...(node.lastCheck === undefined ? {} : { lastCheck: node.lastCheck }),
          ...(at.lastReply === undefined ? {} : { lastReply: at.lastReply }),
          agenda,
          nodes,
          seats: current.seats.map((seat) => ({ seatId: seat.seatId, displayName: seat.displayName, role: seat.role })),
          projectFolder: current.projectFolder,
          ...(discussion === undefined ? {} : { discussion }),
        };
      };
      const ask = deps.proxy;
      /**
       * Lil X at a point the agenda cannot pass by itself. Returns the nodes
       * after its decision, or `undefined` to stop for the host — exactly
       * what would have happened with no proxy.
       */
      const decideByProxy: AgendaPort["decide"] =
        !proxy || ask === undefined
          ? undefined
          : async (at, nodes) => {
              const title = at.phase.title;
              const taken = nodeOf(nodes, at.nodeId).decisions ?? 0;
              // The cap: the node is put down, what waits on it is skipped,
              // and it goes in the report. Without it a node nobody can fix
              // is decided about for ever.
              if (taken >= PROXY_DECISION_CAP) {
                const why = `已经为它做过 ${taken} 个决定，出口仍未通过：${unstopped(at.why)}`;
                const after = applyDecision(agenda, nodes, at.nodeId, { kind: "abandon", why });
                recordDecision(
                  {
                    nodeId: at.nodeId,
                    title,
                    problem: at.why,
                    action: "cap-reached",
                    detail: "决定次数用完，放下这一阶段",
                  },
                  `「${title}」我已经做过 ${taken} 个决定，它仍然过不了：${unstopped(at.why)}。放下它，依赖它的阶段跳过，其余继续；写进给主持人的报告。`,
                );
                return after;
              }
              let decision: ProxyDecision;
              let discussion: DecisionPoint["discussion"];
              try {
                decision = await ask(pointOf(nodes, at), running.abort.signal);
                if (decision.kind === "discuss") {
                  // One round, with the seats it concerns, in the open.
                  const proposal = decision.proposal;
                  said(`关于「${title}」，我的方案：\n${proposal}`);
                  const heard: { seat: string; text: string }[] = [];
                  for (const seatId of decision.seatIds) {
                    if (running.abort.signal.aborted) return undefined;
                    const seat = teamOf(teamId).seats.find((candidate) => candidate.seatId === seatId);
                    if (seat === undefined) continue;
                    const reply = await agendaTurn(
                      teamId,
                      running,
                      seat,
                      "",
                      `Lil X 代主持人就「${title}」卡住的问题提出了下面的方案。只回应这个方案：可行吗，有什么要改，你这边需要什么。不要动手做，先把话说清楚。\n\n${proposal}`,
                      undefined,
                      title,
                      true,
                    );
                    heard.push({ seat: seat.displayName, text: reply.text });
                  }
                  if (running.abort.signal.aborted) return undefined;
                  discussion = { proposal, replies: heard };
                  decision = await ask(pointOf(nodes, at, discussion), running.abort.signal);
                }
              } catch (failure) {
                if (running.abort.signal.aborted) return undefined;
                const detail = failure instanceof Error ? failure.message : String(failure);
                logOf(teamId).append({
                  type: "system/note",
                  entryId: newId("e"),
                  text: `⚠️ Lil X 没能就「${title}」做出决定（${unstopped(detail).slice(0, 160)}）。议程停在这里，等主持人。`,
                });
                return undefined;
              }
              // A second `discuss` is refused by the parser; this is the belt to those braces.
              if (decision.kind === "discuss") return undefined;
              const entry = {
                nodeId: at.nodeId,
                title,
                problem: at.why,
                ...(discussion === undefined ? {} : { discussion }),
              };
              if (decision.kind === "give-up") {
                recordDecision(
                  { ...entry, action: "give-up", detail: `放下：${decision.why}` },
                  `「${title}」我把它放下：${unstopped(decision.why)}。这一条会写进给主持人的报告。`,
                );
                return applyDecision(agenda, nodes, at.nodeId, { kind: "abandon", why: decision.why });
              }
              if (decision.kind === "assign") {
                const name =
                  teamOf(teamId).seats.find((seat) => seat.seatId === decision.seatId)?.displayName ?? decision.seatId;
                recordDecision(
                  { ...entry, action: "assign", detail: `让 ${name} 去清障：${decision.instruction}` },
                  `「${title}」：${unstopped(decision.say)}。@${name} 你来处理。`,
                );
                return applyDecision(agenda, nodes, at.nodeId, {
                  kind: "assign",
                  seatId: decision.seatId,
                  instruction: decision.instruction,
                });
              }
              if (decision.kind === "answer") {
                recordDecision(
                  { ...entry, action: "answer", detail: `代答：${decision.text}` },
                  `「${title}」，回答你们的问题：${decision.text}`,
                );
                return applyDecision(agenda, nodes, at.nodeId, {
                  kind: "retry",
                  instruction: `主持人不在场，以下是 Lil X 代他给出的答复，按它继续做，不要再等确认：\n${decision.text}`,
                });
              }
              recordDecision(
                { ...entry, action: "retry", detail: `重做：${decision.instruction}` },
                `「${title}」：${unstopped(decision.say)}。`,
              );
              return applyDecision(agenda, nodes, at.nodeId, { kind: "retry", instruction: decision.instruction });
            };
      /** A phase asked to stop for the host; Lil X answers in the discussion, where the next phases read it. */
      const answerByProxy: AgendaPort["answer"] =
        !proxy || ask === undefined
          ? undefined
          : async (phase, nodeId, nodes) => {
              try {
                const decision = await ask(
                  pointOf(nodes, {
                    phase,
                    nodeId,
                    reason: "awaiting-host",
                    why: "这一阶段要求停下来等主持人回答",
                    lastReply: undefined,
                  }),
                  running.abort.signal,
                );
                // Whatever it chose, what the seats need here is words.
                const text =
                  decision.kind === "answer"
                    ? decision.text
                    : decision.kind === "discuss"
                      ? decision.proposal
                      : decision.kind === "give-up"
                        ? decision.why
                        : decision.instruction;
                recordDecision(
                  {
                    nodeId,
                    title: phase.title,
                    problem: "这一阶段在等主持人回答",
                    action: "answer",
                    detail: `代答：${text}`,
                  },
                  `「${phase.title}」问到主持人的，我来答：${text}`,
                );
                return true;
              } catch (failure) {
                if (!running.abort.signal.aborted) {
                  const detail = failure instanceof Error ? failure.message : String(failure);
                  logOf(teamId).append({
                    type: "system/note",
                    entryId: newId("e"),
                    text: `⚠️ Lil X 没能回答「${phase.title}」提出的问题（${unstopped(detail).slice(0, 160)}）。议程停在这里，等主持人。`,
                  });
                }
                return false;
              }
            };
      const port: AgendaPort = {
        signal: running.abort.signal,
        ...(decideByProxy === undefined ? {} : { decide: decideByProxy }),
        ...(answerByProxy === undefined ? {} : { answer: answerByProxy }),
        seats: () => teamOf(teamId).seats,
        note: (text) => {
          logOf(teamId).append({ type: "system/note", entryId: newId("e"), text });
          onChanged(teamId);
        },
        turn: (seat, recorded, instruction, window) =>
          agendaTurn(teamId, running, seat, recorded, instruction, window, running.progress.phase),
        snapshot: (seat) => windowForSeat(teamOf(teamId), seat),
        check: (spec) => check(spec, teamOf(teamId).projectFolder, running.abort.signal),
        stamp: async (relative) => {
          try {
            const info = await stat(join(teamOf(teamId).projectFolder, relative));
            return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size } : undefined;
          } catch {
            return undefined;
          }
        },
        // The program writes it, not the agent: a path an agent was merely
        // told to write to may or may not exist afterwards.
        writeArtifact: async (relative, text) => {
          const absolute = join(teamOf(teamId).projectFolder, relative);
          await mkdir(dirname(absolute), { recursive: true });
          await writeFile(absolute, text, "utf8");
          running.artifacts.push(relative);
          logOf(teamId).append({ type: "system/note", entryId: newId("e"), text: `已写入 ${relative}` });
        },
        saveNodes: (next) =>
          persistConfirmed(teamId, (current) => ({ ...current, nodes: next, done: [...passedTitles(agenda, next)] })),
        progress: (progress) => {
          running.progress = progress;
          onChanged(teamId);
        },
        completedTask: (instruction) => running.completedTasks.push(instruction),
        completedPhase: (title) => running.completedPhases.push(title),
      };
      outcome = await runAgendaNodes(port, agenda, nodes);
      // What the host reads instead of having been asked along the way.
      const over = standing(agenda, outcome.nodes);
      if (
        proxy &&
        !running.abort.signal.aborted &&
        outcome.decidingAt === undefined &&
        outcome.pausedAfter === undefined &&
        (over === "finished" || over === "ended")
      ) {
        await writeCompletionReport(teamId, agenda, outcome.nodes, (spec) =>
          check(spec, teamOf(teamId).projectFolder, new AbortController().signal),
        ).catch((error: unknown) => {
          logOf(teamId).append({
            type: "system/note",
            entryId: newId("e"),
            text: `⚠️ 完成报告没写成：${error instanceof Error ? error.message : String(error)}`,
          });
        });
      }
    } finally {
      runtime.roundsInFlight -= 1;
      runtime.agenda = undefined;
      if (!quitting) {
        const stopped = running.abort.signal.aborted;
        const final = outcome ?? { nodes: teamOf(teamId).confirmed?.nodes ?? nodes, artifacts: [] };
        const ending = agendaEnding(agenda, final, stopped);
        note(teamId, ending.kind, ending.detail);
        // Said in the discussion too: the host is looking at the discussion,
        // and an agenda that simply stops producing lines is the silence this ends.
        if (final.decidingAt !== undefined) {
          logOf(teamId).append({
            type: "system/note",
            entryId: newId("e"),
            text:
              `⚠️ 议程停在「${final.decidingAt.phase}」：${unstopped(final.decidingAt.why)}。后面的阶段没有执行。` +
              `在议程卡片上决定怎么办：重做、让别人清障、视为通过，或者放下它。`,
          });
        } else if (!stopped && final.pausedAfter === undefined && standing(agenda, final.nodes) === "ended") {
          logOf(teamId).append({ type: "system/note", entryId: newId("e"), text: ending.detail });
        } else if (!stopped && final.pausedAfter !== undefined) {
          logOf(teamId).append({
            type: "system/note",
            entryId: newId("e"),
            text: `⏸ 「${final.pausedAfter}」做完了，按议程在这里等主持人。看过之后点「继续」。`,
          });
        } else if (!stopped && standing(agenda, final.nodes) === "finished") {
          logOf(teamId).append({ type: "system/note", entryId: newId("e"), text: `🏁 ${ending.detail}` });
        }
        if (stopped && running.reason !== undefined) {
          // From where the NODES stand, not from what this run did: a resumed
          // run knows nothing of phases that passed before it — or passed by
          // the host's decision — and a hand-off that calls them unfinished
          // starts the next person in the wrong place.
          const passed = passedTitles(agenda, final.nodes);
          deps.onAgendaStopped?.(teamId, {
            objective: agenda.hostGoal ?? teamOf(teamId).displayName,
            reason: running.reason,
            completed: [
              ...passed.map((title) => `阶段「${title}」已通过`),
              ...running.completedTasks.filter(
                (instruction) =>
                  !agenda.phases.some(
                    (phase) =>
                      passed.includes(phase.title) && phase.tasks.some((task) => task.instruction === instruction),
                  ),
              ),
            ],
            remaining: outstandingWork(agenda, passed, running.completedTasks),
            artifacts: [...running.artifacts],
            discussion: spokenLines(logOf(teamId).read(), teamOf(teamId).hostDisplayName).map(
              (line) => `【${line.speaker}】${line.text}`,
            ),
          });
        }
        context.roundEnded(teamId);
        exportRecord(teamId);
        emitRoundEnded(
          teamId,
          "agenda",
          repliesOf(teamId, (event) => event.seq > startSeq),
          stopped,
          final.pausedAfter !== undefined || final.decidingAt !== undefined,
        );
        // Commands sent while it ran go out now, however it ended.
        pump(teamId);
      }
      onChanged(teamId);
    }
  };

  /**
   * What the host reads at the end of an agenda Lil X ran, in place of having
   * been asked along the way. Assembled from what was recorded, not written by
   * a model, and about the AGENDA only: whether the requirements are met is
   * the verdict of whoever the plan named to accept the work.
   */
  const writeCompletionReport = async (
    teamId: string,
    agenda: AgendaSpec,
    nodes: NodeMap,
    check: (spec: NonNullable<AgendaPhase["check"]>) => Promise<ExitCheckResult>,
  ): Promise<void> => {
    const team = teamOf(teamId);
    const held = team.confirmed;
    if (held === undefined) return;
    const counts = tally(agenda, nodes);
    const lines: string[] = [`# 完成报告：${team.displayName}`, ""];
    lines.push(`- 目标：${agenda.hostGoal ?? "（议程没有写总目标）"}`);
    lines.push(
      `- 议程：${agenda.phases.length} 个阶段，通过 ${counts.passed}，未解决 ${counts.unresolved}，跳过 ${counts.skipped}`,
    );
    const ledger = phaseLedger(agenda, nodes);
    const unverified = ledger.filter((entry) => entry.state === "passed" && !entry.verified).length;
    if (unverified > 0)
      lines.push(`- **其中 ${unverified} 个阶段的「通过」没有命令验证过**，见下面「各阶段怎么通过的」`);
    lines.push(`- 生成时间：${new Date().toLocaleString()}`, "", "## 各阶段怎么通过的", "");
    for (const entry of ledger) {
      lines.push(
        `- ${entry.verified ? "✅" : entry.state === "passed" ? "⚠️" : "❌"} **${entry.title}**：${entry.line}`,
      );
    }
    lines.push("");
    const dropped = agenda.phases
      .map((phase, index) => ({ phase, node: nodeOf(nodes, nodeIdOf(phase, index)) }))
      .filter(({ node }) => node.state === "unresolved" || node.state === "skipped");
    if (dropped.length > 0) {
      lines.push("## 没有做成的阶段", "");
      for (const { phase, node } of dropped) {
        lines.push(`- **${phase.title}**（${node.state === "unresolved" ? "放下" : "跳过"}）：${node.why ?? ""}`);
      }
      lines.push("");
    }
    const decisions = held.decisions ?? [];
    lines.push(`## Lil X 替你做的决定（${decisions.length}）`, "");
    if (decisions.length === 0) lines.push("没有遇到需要决定的地方。", "");
    for (const [index, one] of decisions.entries()) {
      lines.push(`### ${index + 1}. ${one.title}`, "", `- 问题：${one.problem}`);
      if (one.discussion !== undefined) {
        lines.push(`- 提出的方案：${one.discussion.proposal.replace(/\n/g, " ")}`);
        for (const reply of one.discussion.replies) {
          lines.push(`- ${reply.seat} 的回应：${reply.text.replace(/\n/g, " ").slice(0, 600)}`);
        }
      }
      lines.push(`- 最终执行：${one.detail}`, "");
    }
    if (held.startCommit !== undefined && held.startCommit !== "") {
      const log = await check({ command: `git log --oneline ${held.startCommit}..HEAD | head -200`, timeoutSec: 30 });
      lines.push(
        "## 这期间的提交",
        "",
        "```",
        log.exitCode === 0 && log.tail.trim() !== "" ? log.tail.trim() : "（没有新的提交）",
        "```",
        "",
      );
    }
    lines.push(
      "## 这份报告没有的",
      "",
      "- **需求是否满足**：不在这里。那是验收人的结论，见议程里验收那个阶段的答复。这份报告只说阶段有没有通过。",
      "- **每项改动带来什么风险**：没有评估。上面列的是做了什么，不是它会带来什么后果。",
      "",
    );
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, "0");
    const name = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${held.hash.slice(0, 8)}`;
    const path = await writeReport(team.projectFolder, name, lines.join("\n"));
    persistConfirmed(teamId, (current) => ({ ...current, reportPath: path }));
    logOf(teamId).append({
      type: "system/note",
      entryId: newId("e"),
      text:
        `📋 完成报告已写入 ${path}。议程 ${agenda.phases.length} 个阶段通过 ${counts.passed}` +
        `，未解决 ${counts.unresolved}，跳过 ${counts.skipped}；Lil X 做了 ${decisions.length} 个决定。`,
    });
  };

  /** Started and left running: the click that started an agenda must not hang on minutes of work. */
  const startAgenda = (teamId: string, agenda: AgendaSpec, resuming: boolean, proxied: boolean): void => {
    void runAgenda(teamId, agenda, resuming, proxied).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (!teams.has(teamId)) return;
      logOf(teamId).append({ type: "system/note", entryId: newId("e"), text: `⚠️ 议程没能开始：${detail}` });
      onChanged(teamId);
    });
  };

  /** Stop the running agenda, recording why. The run notices between tasks; a seat mid-answer is cancelled. */
  const stopAgenda = (teamId: string, reason: string): void => {
    const running = runtimeOf(teamId).agenda;
    if (running === undefined) throw new Error("这支团队现在没有在跑议程。");
    if (running.abort.signal.aborted) return;
    running.reason = reason;
    running.abort.abort(new Error(`议程已中止：${reason}`));
    logOf(teamId).append({ type: "system/note", entryId: newId("e"), text: `⏹ 议程被叫停：${reason}` });
    onChanged(teamId);
  };

  const heldAgenda = (teamId: string, verb: string): ConfirmedAgenda => {
    const held = teamOf(teamId).confirmed;
    if (held === undefined) throw new Error("这支团队没有确认过的议程。");
    if (runtimeOf(teamId).agenda !== undefined) throw new Error(`议程正在跑，先叫停再${verb}。`);
    return held;
  };

  // ── restore ────────────────────────────────────────────────────────────
  // Here, after every helper above exists: run earlier, the first restored
  // team hit `newCommand` in its temporal dead zone and every team failed to
  // load — on the restart path only, which nothing short of a restart shows.
  for (const saved of loaded.teams) {
    try {
      if (saved.version !== 2) throw new Error(`team.json 的版本是 ${String(saved.version)}，这一版只认 2。`);
      if (saved.disbandedAt !== undefined) {
        archived.set(saved.teamId, saved);
        continue;
      }
      const runtime = rebuildRuntime(saved, logOf(saved.teamId).read());
      teams.set(saved.teamId, saved);
      runtimes.set(saved.teamId, runtime);
      restoreSeatSessions(saved.teamId, saved.seatSessions);
    } catch (error) {
      // Reported and skipped, never silently dropped.
      problems.push(
        `团队「${saved.displayName ?? saved.teamId}」没能载入：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * A session takes what its team holds in common from its base. Also how a
   * 2.x sitting imported before 3 had sessions (a team of its own, named
   * 「… 那一场」) rejoins the team it came from — once, recorded.
   */
  const joinBase = (team: TeamRecord): void => {
    const legacy = legacySittingBase(team);
    const baseId = team.baseTeamId ?? legacy;
    if (baseId === undefined || baseId === team.teamId) return;
    const base = teams.get(baseId);
    if (base === undefined) return;
    if (legacy === undefined && !sharedDiffers(team, base)) return;
    const joined: TeamRecord = {
      ...team,
      ...sharedOf(base),
      baseTeamId: groupIdOf(base),
      ...(legacy === undefined
        ? {}
        : {
            audit: appendAudit(team.audit ?? [], {
              at: Date.now(),
              kind: "imported",
              detail: `2.x 的这一场（原名「${team.displayName}」）归回团队「${base.displayName}」，成为它的一场会话。`,
            }),
          }),
    };
    teams.set(joined.teamId, joined);
    store.saveTeam(joined.teamId, joined);
  };
  for (const team of [...teams.values()]) joinBase(team);

  return {
    list: () => ({ teams: ordered().map(summary), problems }),

    adopt: (teamId) => {
      if (teams.has(teamId)) throw new Error(`团队 ${teamId} 已经在了。`);
      const saved = store.loadTeam<TeamRecord>(teamId);
      if (saved === undefined) throw new Error(`磁盘上没有团队 ${teamId}。`);
      if (saved.version !== 2) throw new Error(`team.json 的版本是 ${String(saved.version)}，这一版只认 2。`);
      const runtime = rebuildRuntime(saved, logOf(teamId).read());
      teams.set(teamId, saved);
      runtimes.set(teamId, runtime);
      restoreSeatSessions(teamId, saved.seatSessions);
      joinBase(saved);
      onChanged(teamId);
    },

    reload: (teamId) => {
      const runtime = runtimeOf(teamId);
      if (runtime.roundsInFlight > 0 || runtime.preparing || runtime.agenda !== undefined) {
        throw new Error("这场会话还有东西在跑，等它停下再补。");
      }
      const saved = store.loadTeam<TeamRecord>(teamId);
      if (saved === undefined) throw new Error(`磁盘上没有团队 ${teamId}。`);
      runtimes.set(teamId, rebuildRuntime(saved, logOf(teamId).read()));
      teams.set(teamId, saved);
      joinBase(saved);
      onChanged(teamId);
    },

    create: (input) => {
      const projectFolder = canonicalFolder(input.projectFolder.trim());
      const members = input.members ?? [];
      const handmade = input.seats ?? [];
      // Library agents first, then hand-written seats, in the order given:
      // roster order is speaking order.
      const seats = [
        ...members.map((member, index) =>
          seatFromTemplate(templateOf(member.templateId), `seat-${index + 1}`, member.isSecretary === true),
        ),
        ...handmade.map((seat, index) => seatFromInput(seat, `seat-${members.length + index + 1}`)),
      ];
      checkRoster(seats);
      for (const seat of seats) checkConnectionFor(seat.backend, seat.connectionId);
      const teamId = newId("t");
      const record: TeamRecord = {
        version: 2,
        teamId,
        displayName: input.displayName.trim(),
        projectFolder,
        // The person's own name, not a constant. Copied into the team at
        // creation so a rename later cannot rewrite what already-recorded
        // rounds say a participant was called.
        hostDisplayName: hostName(),
        seats,
        createdAt: Date.now(),
        usage: EMPTY_TOTALS,
        perSeat: {},
        seatSessions: {},
      };
      runtimes.set(teamId, rebuildRuntime(record, []));
      save(record);
      note(
        teamId,
        "team-created",
        `建队「${record.displayName}」：${seats.map((seat) => seat.displayName).join("、")}。`,
      );
      onChanged(teamId);
      return { teamId };
    },

    transcript: (teamId) => {
      teamOf(teamId);
      const events = logOf(teamId).read();
      const contextLinesOf = new Map<string, number>();
      const revoked = new Set<string>();
      for (const event of events) {
        if (event.type === "seat/request") contextLinesOf.set(`${event.commandId}/${event.seatId}`, event.contextLines);
        if (event.type === "checkpoint/revoked") revoked.add(event.checkpointId);
      }
      const host = teamOf(teamId).hostDisplayName;
      return events.flatMap((event): TranscriptLine[] => {
        switch (event.type) {
          case "host/message":
            return [
              {
                seq: event.seq,
                entryId: event.commandId,
                commandId: event.commandId,
                kind: "host",
                speaker: host,
                ...(event.agendaPhase === undefined ? {} : { agendaPhase: event.agendaPhase }),
                ...(event.sentFor === undefined ? {} : { sentFor: event.sentFor }),
                text: hostLineText(event),
                at: event.at,
              },
            ];
          case "seat/reply": {
            const contextLines = contextLinesOf.get(`${event.commandId}/${event.seatId}`);
            return [
              {
                seq: event.seq,
                entryId: event.entryId,
                commandId: event.commandId,
                kind: "seat",
                speaker: event.displayName,
                seatId: event.seatId,
                text: `${event.tag}${event.text}`,
                at: event.at,
                failed: event.failed,
                cancelled: event.cancelled,
                durationMs: event.durationMs,
                ...(contextLines === undefined ? {} : { contextLines }),
                ...(event.usage === undefined ? {} : { usage: event.usage }),
              },
            ];
          }
          case "system/note":
            return [
              {
                seq: event.seq,
                entryId: event.entryId,
                kind: "system",
                speaker: "系统",
                text: event.text,
                at: event.at,
              },
            ];
          case "checkpoint/recorded":
            return [
              {
                seq: event.seq,
                entryId: event.checkpointId,
                kind: "checkpoint",
                speaker: "上下文检查点",
                text: event.text,
                at: event.at,
                checkpointId: event.checkpointId,
                revoked: revoked.has(event.checkpointId),
              },
            ];
          case "proxy/said":
            return [
              {
                seq: event.seq,
                entryId: event.entryId,
                kind: "proxy",
                speaker: proxySpeaker(host),
                text: event.text,
                at: event.at,
              },
            ];
          case "seat/request":
          case "command/stopped":
          case "checkpoint/revoked":
            return [];
        }
      });
    },

    seatRequest: (teamId, commandId, seatId) => {
      teamOf(teamId);
      // The LAST request for that seat on that command: a rejected resume is
      // retried with a rebuilt window, and the retry is what actually ran.
      const request = logOf(teamId)
        .read()
        .filter((event) => event.type === "seat/request" && event.commandId === commandId && event.seatId === seatId)
        .at(-1);
      if (request === undefined || request.type !== "seat/request")
        throw new Error("日志里没有这个席位在这一轮的请求记录。");
      return { prompt: request.prompt, contextLines: request.contextLines };
    },

    say: (teamId, text, quoteIds = [], materialIds = [], sentFor) => {
      const team = teamOf(teamId);
      const trimmed = text.trim();
      const named = parseMentions(
        trimmed,
        team.seats.map((seat) => seat.displayName),
      );
      // A misspelled name is refused, not widened to everyone: the box looked
      // like it asked one person, and sending it to all is the worst failure.
      if (named.unknown.length > 0) {
        throw new Error(
          `没有叫「${named.unknown.join("」「")}」的席位。在座的有：${team.seats.map((seat) => seat.displayName).join("、")}。`,
        );
      }
      if (named.instruction.trim() === "") throw new Error("点了名，但没有说要他们做什么。");
      const seatIds =
        named.named.length === 0
          ? team.seats.map((seat) => seat.seatId)
          : named.named.flatMap((name) =>
              team.seats.filter((seat) => seat.displayName === name).map((seat) => seat.seatId),
            );
      return submit(teamId, trimmed, seatIds, quoteIds, materialIds, sentFor);
    },

    cancel,

    resend: (teamId, commandId) => {
      const team = teamOf(teamId);
      const runtime = runtimeOf(teamId);
      const command = runtime.commands.find((candidate) => candidate.commandId === commandId);
      if (command === undefined || command.state !== "interrupted") throw new Error("只有没执行完的命令可以重发。");
      const seatIds = command.seatIds.filter((seatId) => team.seats.some((seat) => seat.seatId === seatId));
      if (seatIds.length === 0) throw new Error("这条命令点名的席位都已经不在团队里了。");
      // The old entry gives way to the new one.
      runtime.commands = runtime.commands.filter((candidate) => candidate !== command);
      // Documents removed since are left out rather than refusing the resend:
      // the host is told which ones by the new line's own attachment note.
      const held = new Set((team.materials ?? []).map((material) => material.materialId));
      return submit(
        teamId,
        command.text,
        seatIds,
        command.quoteIds,
        command.materialIds.filter((id) => held.has(id)),
      );
    },

    stop: (teamId) => {
      const runtime = runtimeOf(teamId);
      const agenda = runtime.agenda !== undefined && !runtime.agenda.abort.signal.aborted;
      if (agenda) stopAgenda(teamId, "主持人叫停");
      const open = runtime.commands.filter(
        (command) => isOpen(command) && !command.abort.signal.aborted && command.agendaPhase === undefined,
      );
      for (const command of open) cancel(teamId, command.commandId);
      return { stopped: agenda || open.length > 0 };
    },

    facts: (teamId) => {
      const team = teamOf(teamId);
      const runtime = runtimeOf(teamId);
      return {
        displayName: team.displayName,
        hostDisplayName: team.hostDisplayName,
        projectFolder: team.projectFolder,
        checkpointCoefficient: team.checkpointCoefficient,
        busy: runtime.roundsInFlight > 0,
        openCommandIds: runtime.commands.filter(isOpen).map((command) => command.commandId),
        secretary: team.seats.find((seat) => seat.isSecretary === true) ?? DEFAULT_SECRETARY,
      };
    },

    folded: (teamId) => {
      forgetSeatSessions(teamId);
      runtimeOf(teamId).seenUpTo.clear();
      saveSessions(teamId);
      onChanged(teamId);
    },

    stopAll: async () => {
      // From here no seat turn writes anything: see `quitting` in runSeat.
      quitting = true;
      const waits: Promise<void>[] = [];
      for (const [teamId, runtime] of runtimes) {
        // Nothing starts after this either: a queued command stays queued in
        // the log and comes back `interrupted`.
        runtime.preparing = true;
        if (runtime.roundsInFlight === 0) continue;
        // An agenda cut off here keeps its nodes; 「继续」 after the restart re-runs what did not pass.
        runtime.agenda?.abort.abort(new Error("Squad 正在退出"));
        for (const command of runtime.commands.filter(isOpen)) command.abort.abort(new Error("Squad 正在退出"));
        waits.push(
          new Promise((resolve) => {
            const check = (): void => {
              if (runtimeOf(teamId).roundsInFlight === 0) resolve();
              else setTimeout(check, 100);
            };
            check();
          }),
        );
      }
      await Promise.all(waits);
    },

    rename: (teamId, displayName) => {
      const name = displayName.trim();
      if (name === "") throw new Error("团队名不能是空的。");
      const before = teamOf(teamId).displayName;
      update(teamId, (team) => ({ ...team, displayName: name }));
      note(teamId, "team-renamed", `「${before}」改名为「${name}」。`);
      onChanged(teamId);
    },

    openSession: (teamId, name) => {
      const from = teamOf(teamId);
      const sessionId = newId("t");
      const label = (name ?? "").trim();
      const record: TeamRecord = {
        version: 2,
        teamId: sessionId,
        ...sharedOf(from),
        baseTeamId: groupIdOf(from),
        ...(label === "" ? {} : { sessionName: label }),
        // The team's name for its host, not today's setting: every session of
        // one team records the host under the same name.
        hostDisplayName: from.hostDisplayName,
        createdAt: Date.now(),
        usage: EMPTY_TOTALS,
        perSeat: {},
        seatSessions: {},
      };
      runtimes.set(sessionId, rebuildRuntime(record, []));
      save(record);
      const sessions = [
        ...sessionsOf(record),
        ...[...archived.values()].filter((one) => groupIdOf(one) === groupIdOf(record)),
      ];
      note(sessionId, "team-created", `「${record.displayName}」开了新会话：${sessionLabel(record, sessions)}。`);
      onChanged(sessionId);
      return { teamId: sessionId };
    },

    renameSession: (teamId, name) => {
      const label = name.trim();
      update(teamId, (team) => {
        const { sessionName: _old, ...rest } = team;
        return label === "" ? rest : { ...rest, sessionName: label };
      });
      onChanged(teamId);
    },

    closeSession: (teamId) => {
      const team = teamOf(teamId);
      if (sessionsOf(team).length <= 1) {
        throw new Error("这是这支团队唯一的一场会话。要整支团队收起来，用「归档」。");
      }
      const runtime = runtimeOf(teamId);
      if (runtime.roundsInFlight > 0 || runtime.preparing || runtime.commands.some(isOpen)) {
        throw new Error("这场会话还有命令在跑，先叫停再归档。");
      }
      note(teamId, "team-disbanded", "归档这场会话。记录留在磁盘上，可以在「归档」里恢复。");
      update(teamId, (current) => ({ ...current, disbandedAt: Date.now(), archivedAs: "session" }));
      putAway(teamId);
      onChanged(teamId);
    },

    archive: () => {
      const label = (record: TeamRecord, group: readonly TeamRecord[]): ArchivedSession => ({
        teamId: record.teamId,
        label: sessionLabel(record, group),
        archivedAt: record.disbandedAt ?? 0,
        createdAt: record.createdAt,
      });
      const byGroup = new Map<string, TeamRecord[]>();
      for (const record of archived.values()) {
        const group = byGroup.get(groupIdOf(record)) ?? [];
        group.push(record);
        byGroup.set(groupIdOf(record), group);
      }
      const view: { teams: ArchiveView["teams"][number][]; sessions: ArchiveView["sessions"][number][] } = {
        teams: [],
        sessions: [],
      };
      for (const [groupId, records] of byGroup) {
        const live = [...teams.values()].filter((team) => groupIdOf(team) === groupId);
        // Numbered among every session the team ever had, live or not.
        const all = [...live, ...records];
        if (live.length > 0) {
          for (const record of records) {
            view.sessions.push({
              ...label(record, all),
              teamName: live[0]?.displayName ?? record.displayName,
              groupId,
            });
          }
          continue;
        }
        const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt);
        const lead = sorted[0];
        if (lead === undefined) continue;
        view.teams.push({
          teamId: lead.teamId,
          displayName: lead.displayName,
          projectFolder: lead.projectFolder,
          archivedAt: Math.max(...records.map((record) => record.disbandedAt ?? 0)),
          sessions: sorted.map((record) => label(record, all)),
        });
      }
      view.teams.sort((a, b) => b.archivedAt - a.archivedAt);
      view.sessions.sort((a, b) => b.archivedAt - a.archivedAt);
      return view;
    },

    restore: (teamId) => {
      const record = archived.get(teamId);
      if (record === undefined) throw new Error("归档里没有这一项。");
      const groupId = groupIdOf(record);
      const live = [...teams.values()].filter((team) => groupIdOf(team) === groupId);
      const inGroup = [...archived.values()].filter((one) => groupIdOf(one) === groupId);
      // A session of a team in use comes back alone, taking what the team
      // holds now. A whole team comes back with the sessions archived with it.
      const bringing =
        live.length > 0
          ? [record]
          : inGroup.filter((one) => one.archivedAs !== "session").length > 0
            ? inGroup.filter((one) => one.archivedAs !== "session")
            : inGroup;
      for (const one of bringing) {
        const { disbandedAt: _at, archivedAs: _as, ...rest } = one;
        const back: TeamRecord = live[0] === undefined ? rest : { ...rest, ...sharedOf(live[0]) };
        runtimes.set(back.teamId, rebuildRuntime(back, logOf(back.teamId).read()));
        teams.set(back.teamId, back);
        archived.delete(back.teamId);
        restoreSeatSessions(back.teamId, back.seatSessions);
        save(back);
        note(back.teamId, "team-created", "从归档里恢复。");
        onChanged(back.teamId);
      }
      return { teamId: bringing.find((one) => one.teamId === teamId)?.teamId ?? teamId };
    },

    remove: (teamId) => {
      const record = archived.get(teamId);
      if (record === undefined) {
        throw new Error(teams.has(teamId) ? "先归档，才能删除。" : "归档里没有这一项。");
      }
      const groupId = groupIdOf(record);
      const live = [...teams.values()].some((team) => groupIdOf(team) === groupId);
      // A session of a team in use goes alone; an archived team goes whole.
      const going = live ? [record] : [...archived.values()].filter((one) => groupIdOf(one) === groupId);
      for (const one of going) {
        store.discardTeam(one.teamId);
        archived.delete(one.teamId);
      }
      onChanged(teamId);
    },

    setCoefficient: (teamId, coefficient) => {
      update(teamId, (team) => ({ ...team, checkpointCoefficient: coefficient }));
      note(
        teamId,
        "team-renamed",
        coefficient === undefined
          ? "折叠阈值改回默认。"
          : `折叠阈值改为上下文窗口的 ${Math.round(coefficient * 100)}%。`,
      );
      onChanged(teamId);
    },

    move: (teamId, delta) => {
      // Teams move, not sessions: a team's sessions stay together under it.
      const groups: string[] = [];
      for (const team of ordered()) if (!groups.includes(groupIdOf(team))) groups.push(groupIdOf(team));
      const at = groups.indexOf(groupIdOf(teamOf(teamId)));
      if (at < 0) throw new Error(`没有这支团队：${teamId}`);
      const to = at + delta;
      if (to < 0 || to >= groups.length) return;
      const [moved] = groups.splice(at, 1);
      if (moved === undefined) return;
      groups.splice(to, 0, moved);
      // Every team gets a position, not just the two swapped: teams never
      // arranged carry none, and a swap between two of them changes nothing.
      for (const [index, groupId] of groups.entries()) {
        for (const team of [...teams.values()].filter((one) => groupIdOf(one) === groupId)) {
          save({ ...team, order: index });
        }
      }
      onChanged(teamId);
    },

    disband: (teamId) => {
      const sessions = sessionsOf(teamOf(teamId));
      for (const session of sessions) {
        const runtime = runtimeOf(session.teamId);
        if (runtime.roundsInFlight > 0 || runtime.preparing || runtime.commands.some(isOpen)) {
          throw new Error(
            sessions.length > 1
              ? "这支团队有一场会话还有命令在跑，先叫停再归档。"
              : "这支团队还有命令在跑，先叫停再归档。",
          );
        }
      }
      for (const session of sessions) {
        note(session.teamId, "team-disbanded", "归档。记录留在磁盘上，可以在「归档」里恢复。");
        update(session.teamId, (team) => ({ ...team, disbandedAt: Date.now(), archivedAs: "team" }));
        putAway(session.teamId);
      }
      onChanged(teamId);
    },

    addSeat: (teamId, input) => {
      const seatId = newSeatId();
      const templateId = (input.templateId ?? "").trim();
      let seat: SeatSpec;
      if (templateId !== "") {
        seat = seatFromTemplate(templateOf(templateId), seatId, input.isSecretary === true);
      } else {
        const role = (input.role ?? "").trim() === "" ? "通用" : (input.role ?? "").trim();
        seat = {
          seatId,
          displayName: (input.displayName ?? "").trim(),
          role,
          systemPrompt: `你的角色是${role}。回答简明，有依据。`,
          backend: input.backend ?? "claude-code",
          ...(input.isSecretary === true ? { isSecretary: true } : {}),
        };
      }
      checkConnectionFor(seat.backend, seat.connectionId);
      setRoster(teamId, [...teamOf(teamId).seats, seat]);
      note(teamId, "seat-added", `加入 ${seat.displayName}（${seat.role}，${seat.backend}）。`);
      return { seatId };
    },

    removeSeat: (teamId, seatId, options = {}) => {
      // The seat's past words STAY in the record. A discussion it took part in
      // happened, and rewriting history to match the current roster would
      // leave later readers reading a conversation with a participant edited
      // out of it.
      const seats = teamOf(teamId).seats;
      const problems = checkRemoval(seats, seatId, {
        ...(options.confirmSecretary === undefined ? {} : { allowSecretary: options.confirmSecretary }),
      });
      if (problems.length > 0) throw new Error(problems.map((problem) => problem.detail).join("\n"));
      setRoster(
        teamId,
        seats.filter((seat) => seat.seatId !== seatId),
      );
      const leaving = seats.find((seat) => seat.seatId === seatId);
      note(teamId, "seat-removed", `${leaving?.displayName ?? seatId} 离开团队。`);
      // Out of every prompt set too: a set naming a seat that left would
      // refuse the next save of the team's prompts for a reason nobody chose.
      update(teamId, (team) =>
        team.prompts === undefined
          ? team
          : {
              ...team,
              prompts: {
                ...team.prompts,
                sets: team.prompts.sets.map((set) => ({ ...set, seatIds: set.seatIds.filter((id) => id !== seatId) })),
              },
            },
      );
      forgetSeatSession(teamId, seatId);
      saveSessions(teamId);
    },

    patchSeat: (teamId, seatId, patch) => {
      const seat = teamOf(teamId).seats.find((candidate) => candidate.seatId === seatId);
      if (seat === undefined) throw new Error(`这支团队里没有席位 ${seatId}。`);
      if (patch.connectionId !== undefined) checkConnectionFor(seat.backend, patch.connectionId);
      const wanted = patch.connectionId?.trim();
      const connectionId = wanted === undefined ? seat.connectionId : wanted === "" ? undefined : wanted;
      replaceSeat(teamId, {
        ...seat,
        connectionId,
        ...(patch.caps === undefined ? {} : { caps: patch.caps }),
      });
      // A conversation belongs to the model that held it: resuming it on
      // another endpoint asks that endpoint for a session it never had.
      if (connectionId !== seat.connectionId) {
        forgetSeatSession(teamId, seatId);
        saveSessions(teamId);
      }
    },

    relinkSeat: (teamId, seatId, templateId) => {
      // By id, never by name: two agents may share a display name, and a wrong
      // guess here silently changes which model a seat runs on.
      const template = templateOf(templateId);
      const seat = teamOf(teamId).seats.find((candidate) => candidate.seatId === seatId);
      if (seat === undefined) throw new Error("这支团队里没有这个成员。");
      const next = syncSeat({ ...seat, templateId: template.templateId }, templateFacts(template));
      checkConnectionFor(next.backend, next.connectionId);
      replaceSeat(teamId, next);
      if (next.backend !== seat.backend || next.connectionId !== seat.connectionId) {
        forgetSeatSession(teamId, seatId);
        saveSessions(teamId);
      }
    },

    syncTemplate: (template) => {
      // Refusals are collected rather than thrown: the template WAS saved, and
      // failing the whole save over one busy team would leave the person
      // believing the edit did not happen at all.
      const refused: string[] = [];
      const facts = templateFacts(template);
      for (const team of ordered()) {
        const plan = planSeatSync(team.seats, facts);
        if (plan.length === 0) continue;
        try {
          let seats = team.seats;
          for (const change of plan) {
            seats = placeSeat(
              seats.filter((seat) => seat.seatId !== change.seat.seatId),
              change.seat,
              change.at,
            );
          }
          setRoster(team.teamId, seats);
          for (const change of plan) {
            const before = team.seats[change.at];
            if (before?.backend !== change.seat.backend || before.connectionId !== change.seat.connectionId) {
              forgetSeatSession(team.teamId, change.seat.seatId);
            }
          }
          saveSessions(team.teamId);
        } catch (error) {
          refused.push(`${team.displayName}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return refused;
    },

    addMaterial: (teamId, incoming) => {
      const held = teamOf(teamId).materials ?? [];
      const problem = checkMaterial(incoming, held);
      if (problem !== undefined) throw new Error(problem.detail);
      const material: Material = {
        materialId: newId("m"),
        name: incoming.name,
        text: incoming.text.trim(),
        addedAt: Date.now(),
      };
      update(teamId, (team) => ({ ...team, materials: [...(team.materials ?? []), material] }));
      note(teamId, "material-added", `导入「${material.name}」，${material.text.length.toLocaleString()} 字。`);
      onChanged(teamId);
      return { materialId: material.materialId };
    },

    setMaterialPinned: (teamId, materialId, pinned) => {
      const held = teamOf(teamId).materials ?? [];
      if (!held.some((material) => material.materialId === materialId)) throw new Error("没有这份资料。");
      update(teamId, (team) => ({
        ...team,
        materials: (team.materials ?? []).map((material) =>
          material.materialId === materialId ? { ...material, pinned } : material,
        ),
      }));
      onChanged(teamId);
    },

    removeMaterial: (teamId, materialId) => {
      // What earlier commands carried stays in the record (their attachment
      // note); only what the team holds from now on changes.
      const gone = (teamOf(teamId).materials ?? []).find((material) => material.materialId === materialId);
      if (gone === undefined) return;
      update(teamId, (team) => ({
        ...team,
        materials: (team.materials ?? []).filter((material) => material.materialId !== materialId),
      }));
      note(teamId, "material-removed", `移除「${gone.name}」。`);
      onChanged(teamId);
    },

    setPrompts: (teamId, prompts) => {
      const team = teamOf(teamId);
      const known = {
        blockIds: prompts.blocks.map((block) => block.blockId),
        seatIds: team.seats.map((seat) => seat.seatId),
      };
      const refusals = prompts.sets.flatMap((set) =>
        checkPromptSet(set, known)
          .filter((problem) => problem.severity === "error")
          .map((problem) => `集合「${set.name}」：${problem.detail}`),
      );
      const unknown = prompts.teamBlockIds.filter((id) => !known.blockIds.includes(id));
      if (unknown.length > 0) refusals.push(`团队提示词里有本队没有的片段：${unknown.join("、")}。`);
      if (refusals.length > 0) throw new Error(refusals.join("\n"));
      update(teamId, (current) => ({ ...current, prompts }));
      note(
        teamId,
        "team-renamed",
        `改了共用提示词：${prompts.teamBlockIds.length} 段全员、${prompts.sets.length} 个集合、共 ${prompts.blocks.length} 段片段。`,
      );
      onChanged(teamId);
    },

    note: (teamId, kind, detail) => {
      note(teamId, kind, detail);
      onChanged(teamId);
    },

    recordNote: (teamId, text) => {
      logOf(teamId).append({ type: "system/note", entryId: newId("e"), text });
      onChanged(teamId);
    },

    setDraft: (teamId, agenda, options = {}) => {
      const { fromEntryId, criteria, author } = options;
      const team = teamOf(teamId);
      const problems = checkAgendaAgainstRoster(
        agenda,
        team.seats.map((seat) => seat.seatId),
      );
      if (problems.length > 0) {
        throw new Error(problems.map((problem) => `「${problem.phase}」：${problem.detail}`).join("\n"));
      }
      // The id is the TEAM's plan identity and survives re-drafts; the
      // revision counts them.
      const draft: AgendaDraftRecord = {
        agenda,
        at: Date.now(),
        agendaId: team.draft?.agendaId ?? `ag-${teamId}`,
        revision: (team.draft?.revision ?? 0) + 1,
        ...(fromEntryId === undefined ? {} : { fromEntryId }),
        ...(criteria === undefined || criteria.length === 0 ? {} : { criteria }),
        ...(author === undefined ? {} : { author }),
      };
      update(teamId, (current) => ({ ...current, draft }));
      note(
        teamId,
        "agenda-drafted",
        `${author === undefined ? "秘书" : DRAFT_AUTHORS[author]}拟了第 ${draft.revision} 版草案，${agenda.phases.length} 个阶段。`,
      );
      onChanged(teamId);
      return { agendaId: draft.agendaId, revision: draft.revision };
    },

    resolveAgenda: (teamId, verdict) => {
      const team = teamOf(teamId);
      // A draft must be STANDING: `verdict.agenda` edits it, it cannot conjure
      // one. 「秘书提议、主持人确认」 is only a rule if there is always a
      // proposal to confirm.
      const standingDraft = team.draft;
      const legal = agendaEditIsLegal(standingDraft?.agenda, verdict.agenda);
      if (!legal.ok) throw new Error(legal.detail ?? "这份议程不能确认。");
      // And the draft this caller was LOOKING at: two windows, or one left open
      // while the secretary re-drafted, and the last writer silently wins.
      if (standingDraft !== undefined) {
        const named = draftIdentityMatches(
          { agendaId: standingDraft.agendaId, revision: standingDraft.revision },
          { agendaId: verdict.agendaId, revision: verdict.revision },
        );
        if (!named.ok) throw new Error(named.detail ?? "这份草案已经不是当前那一份了。");
      }
      const held = verdict.agenda ?? (standingDraft?.agenda as AgendaSpec);
      if (verdict.kind === "discard") {
        update(teamId, (current) => ({ ...current, draft: undefined }));
        note(teamId, "agenda-discarded", `主持人丢弃了第 ${standingDraft?.revision ?? 0} 版草案。`);
        onChanged(teamId);
        return;
      }
      // An edited draft is re-checked: the roster rule has to run on what the
      // host actually confirmed, not on what the secretary first proposed.
      const problems = checkAgendaAgainstRoster(
        held,
        team.seats.map((seat) => seat.seatId),
      );
      if (problems.length > 0) {
        throw new Error(problems.map((problem) => `「${problem.phase}」：${problem.detail}`).join("\n"));
      }
      if (runtimeOf(teamId).agenda !== undefined) throw new Error("这支团队已经在跑一个议程了。");
      update(teamId, (current) => ({ ...current, draft: undefined }));
      startAgenda(teamId, held, false, verdict.proxy === true);
    },

    resumeAgenda: (teamId) => {
      const held = heldAgenda(teamId, "续跑");
      const nodes = held.nodes;
      // A finished agenda is kept, so 「跑完了」 has to be refused here.
      const stood = standing(held.agenda, nodes);
      if (stood === "finished") throw new Error("这份议程已经跑完了。要重跑某个阶段，先把它退回去。");
      if (stood === "ended") {
        throw new Error("这份议程已经结束，剩下的阶段都被放下或跳过了。要重跑某个阶段，先把它退回去。");
      }
      // 「继续」 on a node waiting for a decision IS a decision: do it again.
      if (stood === "deciding") {
        let next = nodes;
        for (const [index, phase] of held.agenda.phases.entries()) {
          const id = nodeIdOf(phase, index);
          if (nodeOf(next, id).state === "deciding") next = applyDecision(held.agenda, next, id, { kind: "retry" });
        }
        persistConfirmed(teamId, (current) => ({ ...current, nodes: next }));
      }
      startAgenda(teamId, held.agenda, true, false);
    },

    rewindAgenda: (teamId, phaseIndex) => {
      const held = heldAgenda(teamId, "回退");
      if (phaseIndex < 0 || phaseIndex >= held.agenda.phases.length)
        throw new Error(`没有第 ${phaseIndex + 1} 个阶段。`);
      const title = held.agenda.phases[phaseIndex]?.title ?? "";
      const rewound = rewindTo(held.agenda, held.nodes, phaseIndex);
      persistConfirmed(teamId, (current) => ({
        ...current,
        nodes: rewound,
        done: [...passedTitles(held.agenda, rewound)],
      }));
      note(teamId, "agenda-rewound", `退回到第 ${phaseIndex + 1} 阶段「${title}」，等主持人续跑。`);
      // The discussion is NOT rewound: the re-run sees the earlier attempt and
      // the argument against it, which is the only way it can be different.
      logOf(teamId).append({
        type: "system/note",
        entryId: newId("e"),
        text:
          `⏪ 主持人把议程退回到第 ${phaseIndex + 1} 阶段「${title}」。` +
          `之前说过的话都留着——重跑这一阶段的席位看得见它们，包括为什么要重来。`,
      });
      onChanged(teamId);
    },

    decideNode: (teamId, nodeId, decision) => {
      const held = heldAgenda(teamId, "决定");
      const team = teamOf(teamId);
      if (decision.kind === "assign" && !team.seats.some((seat) => seat.seatId === decision.seatId)) {
        throw new Error(`名册上没有席位「${decision.seatId}」。`);
      }
      const nodes = applyDecision(held.agenda, held.nodes, nodeId, decision);
      const index = held.agenda.phases.findIndex((phase, at) => nodeIdOf(phase, at) === nodeId);
      const title = held.agenda.phases[index]?.title ?? nodeId;
      const said =
        decision.kind === "retry"
          ? `重做${decision.instruction === undefined || decision.instruction.trim() === "" ? "" : `，并交代：${decision.instruction.trim()}`}`
          : decision.kind === "assign"
            ? `让 ${team.seats.find((seat) => seat.seatId === decision.seatId)?.displayName ?? decision.seatId} 去清障：${decision.instruction}`
            : decision.kind === "pass"
              ? "视为通过，不再检查"
              : "放下它，不再做";
      persistConfirmed(teamId, (current) => ({ ...current, nodes, done: [...passedTitles(held.agenda, nodes)] }));
      note(teamId, "agenda-decided", `「${title}」：${unstopped(said)}。`);
      logOf(teamId).append({
        type: "system/note",
        entryId: newId("e"),
        text: `🧭 主持人对「${title}」的决定：${unstopped(said)}。`,
      });
      const stood = standing(held.agenda, nodes);
      if (stood === "finished" || stood === "ended") {
        // The decision was the last thing it needed; no run follows to say so.
        const counts = tally(held.agenda, nodes);
        const summaryLine =
          stood === "finished"
            ? `议程跑完，${counts.passed} 个阶段全部通过。`
            : `议程结束：通过 ${counts.passed}，未解决 ${counts.unresolved}，因此跳过 ${counts.skipped}。`;
        note(teamId, "agenda-finished", summaryLine);
        logOf(teamId).append({ type: "system/note", entryId: newId("e"), text: summaryLine });
      }
      onChanged(teamId);
      // Choosing and then having to press 「继续」 as well is one decision asked for twice.
      if (stood === "runnable") startAgenda(teamId, held.agenda, true, false);
    },

    abandonAgenda: (teamId) => {
      const held = heldAgenda(teamId, "放弃");
      const total = held.agenda.phases.length;
      const stood = standing(held.agenda, held.nodes);
      // Putting away an agenda that already ended is not giving up on it: the
      // record should say which one the host did (the button already does).
      const over = stood === "finished" || stood === "ended";
      update(teamId, (current) => ({ ...current, confirmed: undefined }));
      note(
        teamId,
        "agenda-abandoned",
        over
          ? `主持人收起了这份已经结束的议程（通过 ${held.done.length} / ${total} 个阶段）。`
          : `主持人放弃了这份议程，当时完成 ${held.done.length} / ${total} 个阶段。`,
      );
      // For the seats' sake: their instructions still read 「（阶段…）」, and
      // without this the next thing asked looks like part of a plan that no
      // longer exists.
      logOf(teamId).append({
        type: "system/note",
        entryId: newId("e"),
        text: over
          ? `🗂 主持人收起了这份已经结束的议程（通过 ${held.done.length} / ${total} 个阶段）。之前说过的话都留着。`
          : `🗑 主持人放弃了这份议程（已完成 ${held.done.length} / ${total} 个阶段）。之前说过的话都留着；后面不再按它的阶段往下走。`,
      });
      onChanged(teamId);
    },
  };
}
