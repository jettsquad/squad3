/**
 * plan.ts — one 2.x team, turned into a 3 team on paper. Pure: nothing is
 * read or written here, so every rule below is tested without a disk.
 *
 * 3 新写。规矩照 2.x `@squad/migrate`（README 里的那几条），格式照 2.x 8e96d9c 的
 * `table/domain.ts`（团队行）、`table/log.ts`（记录文件）、`context/domain.ts`（检查点）。
 *
 * The rules, and why each one:
 *
 * - **Anything unreadable refuses THIS team.** A partly migrated team looks
 *   complete and has a hole in it, and the only evidence the hole was ever
 *   anything is the thing that was dropped. Refusal is per team, not per batch.
 * - **turnIds are kept.** A checkpoint's `coversUpTo` names a 2.x turn; a
 *   fresh id would leave every carried checkpoint covering a boundary that
 *   does not exist.
 * - **Revocation travels.** A checkpoint the host retired must not come back
 *   to life because it moved.
 * - **No catch-all for kinds.** Every 2.x record kind is either converted,
 *   listed as carrying nothing, or reported.
 */
import { CUT_SHORT_MARK, excerpt, type AuditEntry, type AuditKind, type ConfirmedAgenda } from "../table/index.ts";
import {
  nodeIdOf,
  nodeOf,
  parseAgendaSpec,
  type AgendaSpec,
  type NodeMap,
  type ProxyDecisionEntry,
} from "../../shared/index.ts";
import type { TeamLogEntry } from "../../shared/team-log.ts";
import type { SeatSpec } from "../../shared/seat.ts";
import type { Material } from "../../shared/material.ts";
import type { UsageTotals } from "../../shared/seat-usage.ts";
import { EMPTY_TOTALS } from "../../shared/seat-usage.ts";

/** One line of a 2.x record file (`squad-records/<id>.jsonl`), as `log.ts` writes it. */
export interface RecordLine {
  readonly turnId: string;
  readonly kind: string;
  readonly at: number;
  readonly text: string;
}

/** One row of the 2.x `squad_teams.checkpoints` table. */
export interface CheckpointRow {
  readonly teamId: string;
  readonly checkpointId: string;
  readonly text: string;
  readonly coversUpTo: string;
  readonly createdAt: number;
  readonly revokedAt?: number | undefined;
}

/** A 3 log entry with the time it was SAID, not the time it was imported. */
export type TimedEntry = TeamLogEntry & { readonly at: number };

/** The 3 team record an import writes — the shape `table` reads as `TeamRecord`. */
export interface ImportedTeam {
  readonly version: 2;
  readonly teamId: string;
  readonly displayName: string;
  readonly projectFolder: string;
  readonly hostDisplayName: string;
  readonly seats: readonly SeatSpec[];
  readonly createdAt: number;
  readonly usage: UsageTotals;
  readonly perSeat: Readonly<Record<string, UsageTotals>>;
  readonly seatSessions: Readonly<Record<string, never>>;
  readonly checkpointCoefficient?: number | undefined;
  readonly materials?: readonly Material[] | undefined;
  /** A confirmed agenda that had finished in 2.x, kept as 3 keeps one after it runs. */
  readonly confirmed?: ConfirmedAgenda | undefined;
  readonly audit: readonly AuditEntry[];
}

/**
 * The confirmed agenda of a 2.x row: none, finished (carried as 3 holds it),
 * still running, or unreadable. 2.x keeps the plan's parts in separate
 * `confirmed*` fields; 3 keeps them in one `confirmed` object with the same
 * contents (its agenda machine was ported from 2.x).
 */
export function finishedAgendaOf(
  row: Record<string, unknown>,
):
  | { readonly kind: "none" }
  | { readonly kind: "finished"; readonly agenda: ConfirmedAgenda }
  | { readonly kind: "running" | "unreadable"; readonly detail: string } {
  if (row["confirmed"] === undefined) return { kind: "none" };
  let agenda: AgendaSpec;
  try {
    agenda = parseAgendaSpec(row["confirmed"]);
  } catch (error) {
    return { kind: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
  const nodes = (
    typeof row["confirmedNodes"] === "object" && row["confirmedNodes"] !== null ? row["confirmedNodes"] : {}
  ) as NodeMap;
  const open = agenda.phases
    .map((phase, index) => ({ title: phase.title, state: nodeOf(nodes, nodeIdOf(phase, index)).state }))
    .filter((node) => node.state !== "passed" && node.state !== "skipped");
  if (open.length > 0) {
    return { kind: "running", detail: open.map((node) => `「${node.title}」${node.state}`).join("、") };
  }
  const list = <T>(key: string): T[] => (Array.isArray(row[key]) ? (row[key] as T[]) : []);
  const text = (key: string): string | undefined => (typeof row[key] === "string" ? (row[key] as string) : undefined);
  const startCommit = text("confirmedStartCommit");
  const reportPath = text("confirmedReportPath");
  return {
    kind: "finished",
    agenda: {
      agenda,
      at: typeof row["confirmedAt"] === "number" ? row["confirmedAt"] : 0,
      done: list<string>("confirmedDone"),
      nodes,
      hash: text("confirmedHash") ?? "",
      roster: list<ConfirmedAgenda["roster"][number]>("confirmedRoster"),
      ...(row["confirmedProxy"] === true ? { proxy: true } : {}),
      decisions: list<ProxyDecisionEntry>("confirmedDecisions"),
      ...(startCommit === undefined ? {} : { startCommit }),
      ...(reportPath === undefined ? {} : { reportPath }),
    },
  };
}

export interface TeamPlan {
  readonly teamId: string;
  /** What it will be called in 3. A sitting gets its date, so two sittings of one team can be told apart. */
  readonly displayName: string;
  readonly sittingOf?: string | undefined;
  /** Empty means it can be imported. */
  readonly problems: readonly string[];
  /** Things carried differently, or not carried, said so the report is complete. */
  readonly notes: readonly string[];
  readonly record: ImportedTeam;
  readonly events: readonly TimedEntry[];
  readonly counts: {
    readonly host: number;
    readonly seat: number;
    readonly system: number;
    readonly proxy: number;
    readonly checkpoints: number;
  };
}

/** Record kinds that carry no content: dsh's own session settings, written once at the start of every host log. */
export const CARRIES_NOTHING: ReadonlySet<string> = new Set(["permission/preset", "sandbox/mode", "approval/policy"]);

/** The one kind that is speech. */
const SPEECH = "user/message";

/** Team-row fields that are converted, or deliberately left behind with a note. */
const HANDLED_ROW_KEYS = new Set([
  "teamId",
  "sessionId",
  "baseTeamId",
  "displayName",
  "projectFolder",
  "hostDisplayName",
  "checkpointCoefficient",
  "seats",
  "usage",
  "materials",
  "audit",
  "seatSessions",
  "createdAt",
  "selection",
]);

/**
 * The confirmed agenda. Carried when it has finished — every phase passed or
 * skipped, which is how 2.x (and 3) keep a plan after it ran, so a phase can
 * be run again. Refused while it is still mid-run: an agenda half-run is
 * exactly the kind of thing whose absence nobody would notice.
 */
const CONFIRMED_KEYS = [
  "confirmed",
  "confirmedAt",
  "confirmedDone",
  "confirmedNodes",
  "confirmedStartCommit",
  "confirmedReportPath",
  "confirmedProxy",
  "confirmedDecisions",
  "confirmedHash",
  "confirmedRoster",
];

/**
 * Team-row fields that hold work in progress this importer does not carry:
 * a draft waiting on the host, commands not yet answered. Refused rather than
 * dropped.
 */
const IN_PROGRESS_KEYS = [
  "draft",
  "draftedAt",
  "draftFromTurnId",
  "draftAgendaId",
  "draftRevision",
  "commands",
  "queued",
];

const SEAT_KEYS = new Set([
  "seatId",
  "displayName",
  "role",
  "systemPrompt",
  "backend",
  "isSecretary",
  "connectionId",
  "caps",
  "permissionMode",
  "templateId",
  "color",
  "voiceId",
  "webAccess",
  "subagents",
  "hostCustomizations",
  "reasoningEffort",
]);

const AUDIT_KINDS: ReadonlySet<string> = new Set<AuditKind>([
  "team-created",
  "team-origin",
  "team-renamed",
  "team-disbanded",
  "seat-added",
  "seat-removed",
  "agenda-drafted",
  "agenda-confirmed",
  "agenda-resumed",
  "agenda-paused",
  "agenda-stopped",
  "agenda-finished",
  "agenda-discarded",
  "agenda-rewound",
  "agenda-abandoned",
  "agenda-decided",
  "material-added",
  "material-removed",
  "checkpoint-folded",
  "checkpoint-revoked",
  "seat-quiet",
  "imported",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** `【speaker】text`, as 2.x writes every line of discussion. */
export function splitSpeaker(text: string): { readonly speaker: string; readonly body: string } | undefined {
  const match = /^【([^】]+)】([\s\S]*)$/.exec(text);
  return match === null ? undefined : { speaker: match[1] as string, body: match[2] as string };
}

/** `（答 HH:MM「excerpt」）\n`, the tag 2.x puts on a reply to a command that is not the latest. */
export function splitTag(
  body: string,
): { readonly tag: string; readonly clock: string; readonly quoted: string; readonly rest: string } | undefined {
  const match = /^（答 (\d\d:\d\d)「([^」]*)」）\n/.exec(body);
  return match === null
    ? undefined
    : { tag: match[0], clock: match[1] as string, quoted: match[2] as string, rest: body.slice(match[0].length) };
}

const clockOf = (at: number): string => {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const stamp = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function usageOf(value: unknown): UsageTotals {
  if (!isObject(value)) return EMPTY_TOTALS;
  const cost = num(value["costUsd"]);
  const duration = num(value["durationMs"]);
  return {
    turns: num(value["turns"]) ?? 0,
    inputTokens: num(value["inputTokens"]) ?? 0,
    outputTokens: num(value["outputTokens"]) ?? 0,
    cacheReadTokens: num(value["cacheReadTokens"]) ?? 0,
    cacheCreationTokens: num(value["cacheCreationTokens"]) ?? 0,
    ...(cost === undefined ? {} : { costUsd: cost }),
    ...(duration === undefined ? {} : { durationMs: duration }),
  };
}

/**
 * Plan one team. `row` is the 2.x `squad_table.teams` row; `records` its
 * record file, or undefined when there is none; `checkpoints` the rows of
 * `squad_teams.checkpoints` for this team id.
 */
export function planTeam(input: {
  readonly row: unknown;
  readonly records: readonly RecordLine[] | undefined;
  readonly checkpoints: readonly CheckpointRow[];
  /** The base team's display name, for naming a sitting. */
  readonly baseName?: string | undefined;
  readonly importedAt: number;
}): TeamPlan {
  const problems: string[] = [];
  const notes: string[] = [];
  const row = isObject(input.row) ? input.row : {};
  const teamId = str(row["teamId"]) ?? "";
  if (teamId === "") problems.push("团队行没有 teamId。");

  const inProgress = Object.keys(row).filter((key) => IN_PROGRESS_KEYS.includes(key) && row[key] !== undefined);
  if (inProgress.length > 0) {
    problems.push(
      `这支团队有还没处理的议程草案或没答完的指令（字段 ${inProgress.join("、")}），这一版导入不带它——先在 2.x 里确认或丢弃草案、等指令答完，再导入。`,
    );
  }
  for (const key of Object.keys(row)) {
    if (!HANDLED_ROW_KEYS.has(key) && !IN_PROGRESS_KEYS.includes(key) && !CONFIRMED_KEYS.includes(key)) {
      problems.push(`团队行里有不认识的字段「${key}」。`);
    }
  }
  const finished = finishedAgendaOf(row);
  if (finished.kind === "running") {
    problems.push(
      `这支团队的议程还没跑完（${finished.detail}），这一版导入不带跑到一半的议程——先在 2.x 里把议程跑完或放弃，再导入。`,
    );
  }
  if (finished.kind === "unreadable") problems.push(`这支团队确认过的议程读不懂：${finished.detail}`);

  const name = str(row["displayName"]) ?? "";
  const projectFolder = str(row["projectFolder"]) ?? "";
  const host = str(row["hostDisplayName"]) ?? "";
  const createdAt = num(row["createdAt"]) ?? input.importedAt;
  const sittingOf = str(row["baseTeamId"]);
  if (name.trim() === "") problems.push("团队没有名字。");
  if (projectFolder.trim() === "") problems.push("团队没有项目文件夹。");
  if (host.trim() === "") problems.push("团队行里没有主持人的名字，分不出哪些话是主持人说的。");

  // ── seats ──
  const seats: SeatSpec[] = [];
  const rawSeats = Array.isArray(row["seats"]) ? row["seats"] : [];
  if (rawSeats.length === 0) problems.push("名册是空的。");
  for (const [index, raw] of rawSeats.entries()) {
    if (!isObject(raw)) {
      problems.push(`第 ${index + 1} 个席位不是一个对象。`);
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!SEAT_KEYS.has(key)) problems.push(`席位「${String(raw["displayName"])}」有不认识的字段「${key}」。`);
    }
    const backend = raw["backend"];
    if (backend !== "claude-code" && backend !== "codex" && backend !== "dsh") {
      problems.push(`席位「${String(raw["displayName"])}」的后端「${String(backend)}」不认识。`);
      continue;
    }
    const seatId = str(raw["seatId"]);
    const displayName = str(raw["displayName"]);
    if (seatId === undefined || displayName === undefined) {
      problems.push(`第 ${index + 1} 个席位缺 seatId 或名字。`);
      continue;
    }
    // Copied field by field: a key this list does not name was refused above.
    seats.push({ ...(raw as unknown as SeatSpec), seatId, displayName, backend });
  }
  const seatByName = new Map(seats.map((seat) => [seat.displayName, seat]));

  // ── the record ──
  const events: TimedEntry[] = [];
  const counts = { host: 0, seat: 0, system: 0, proxy: 0, checkpoints: 0 };
  const proxyName = `Lil X（代${host}）`;
  /** Former members: spoke in the record, are not on the roster now. */
  const formers = new Map<string, string>();
  /** Host messages so far, newest last: what a reply answers. */
  const commands: { commandId: string; at: number; text: string; index: number; seatIds: string[] }[] = [];
  const entryIds = new Set<string>();

  if (input.records === undefined) {
    problems.push(
      `没有找到这支团队的记录文件（squad-records/${teamId}.jsonl）。2.x 在第一次用新版打开团队时才建它；先在 2.x 里打开这支团队一次。`,
    );
  }
  for (const [index, line] of (input.records ?? []).entries()) {
    const where = `第 ${index + 1} 条记录`;
    if (CARRIES_NOTHING.has(line.kind)) continue;
    if (line.kind !== SPEECH) {
      problems.push(`${where}的类型「${line.kind}」不认识。`);
      continue;
    }
    const spoken = splitSpeaker(line.text);
    if (spoken === undefined) {
      problems.push(`${where}看不出是谁说的（没有【名字】）。`);
      continue;
    }
    if (entryIds.has(line.turnId)) {
      problems.push(`${where}的 turnId「${line.turnId}」和前面的重复了。`);
      continue;
    }
    entryIds.add(line.turnId);
    const { speaker, body } = spoken;
    if (speaker === host) {
      commands.push({ commandId: line.turnId, at: line.at, text: body, index: events.length, seatIds: [] });
      events.push({ type: "host/message", commandId: line.turnId, text: body, seatIds: [], quoteIds: [], at: line.at });
      counts.host += 1;
    } else if (speaker === "系统") {
      events.push({ type: "system/note", entryId: line.turnId, text: body, at: line.at });
      counts.system += 1;
    } else if (speaker === proxyName) {
      events.push({ type: "proxy/said", entryId: line.turnId, text: body, at: line.at });
      counts.proxy += 1;
    } else {
      // A seat: on the roster, or a former member.
      let seatId = seatByName.get(speaker)?.seatId;
      if (seatId === undefined) {
        seatId = formers.get(speaker) ?? `former-${formers.size + 1}`;
        formers.set(speaker, seatId);
      }
      const tagged = splitTag(body);
      const answered =
        tagged === undefined
          ? commands.at(-1)
          : [...commands]
              .reverse()
              .find((command) => clockOf(command.at) === tagged.clock && excerpt(command.text) === tagged.quoted);
      if (answered === undefined) {
        problems.push(
          tagged === undefined
            ? `${where}是「${speaker}」的答复，但前面没有主持人的指令，说不清它在答什么。`
            : `${where}标着「答 ${tagged.clock}「${tagged.quoted}」」，找不到对得上的那条指令。`,
        );
        continue;
      }
      const text = tagged === undefined ? body : tagged.rest;
      if (!answered.seatIds.includes(seatId)) answered.seatIds.push(seatId);
      events.push({
        type: "seat/reply",
        commandId: answered.commandId,
        entryId: line.turnId,
        seatId,
        displayName: speaker,
        text,
        tag: tagged?.tag ?? "",
        // 2.x's own marks: a failure is written starting with ⚠️, a reply a
        // stop cut short ends with the cut-short mark.
        failed: text.trim().startsWith("⚠️"),
        cancelled: text.trimEnd().endsWith(CUT_SHORT_MARK),
        durationMs: 0,
        at: line.at,
      });
      counts.seat += 1;
    }
  }
  // Who each command went to, as far as the record shows: the seats that answered it.
  for (const command of commands) {
    const event = events[command.index];
    if (event?.type === "host/message") events[command.index] = { ...event, seatIds: [...command.seatIds] };
  }
  for (const [speaker, seatId] of formers) {
    notes.push(`「${speaker}」在记录里说过话，但现在不在名册上（换过人或改过名），按已离席的成员导入（${seatId}）。`);
  }

  // ── checkpoints ──
  for (const checkpoint of [...input.checkpoints].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!entryIds.has(checkpoint.coversUpTo)) {
      problems.push(`检查点 ${checkpoint.checkpointId} 覆盖到「${checkpoint.coversUpTo}」，记录里没有这一条。`);
      continue;
    }
    // After the line it covers, and at the time it was written.
    const covered = events.findIndex((event) => entryOf(event) === checkpoint.coversUpTo);
    let at = events.findIndex((event, position) => position > covered && event.at > checkpoint.createdAt);
    if (at < 0) at = events.length;
    events.splice(at, 0, {
      type: "checkpoint/recorded",
      checkpointId: checkpoint.checkpointId,
      text: checkpoint.text,
      coversUpTo: checkpoint.coversUpTo,
      at: checkpoint.createdAt,
    });
    counts.checkpoints += 1;
    if (checkpoint.revokedAt !== undefined) {
      const revokedAt = checkpoint.revokedAt;
      let position = events.findIndex((event, index) => index > at && event.at > revokedAt);
      if (position < 0) position = events.length;
      events.splice(position, 0, { type: "checkpoint/revoked", checkpointId: checkpoint.checkpointId, at: revokedAt });
    }
  }

  // ── the rest of the row ──
  const materials: Material[] = [];
  for (const raw of Array.isArray(row["materials"]) ? row["materials"] : []) {
    if (
      !isObject(raw) ||
      str(raw["materialId"]) === undefined ||
      str(raw["name"]) === undefined ||
      str(raw["text"]) === undefined
    ) {
      problems.push("有一份资料读不懂。");
      continue;
    }
    materials.push({
      materialId: raw["materialId"] as string,
      name: raw["name"] as string,
      text: raw["text"] as string,
      addedAt: num(raw["addedAt"]) ?? createdAt,
      ...(raw["pinned"] === true ? { pinned: true } : {}),
    });
  }
  const audit: AuditEntry[] = [];
  for (const raw of Array.isArray(row["audit"]) ? row["audit"] : []) {
    if (
      !isObject(raw) ||
      num(raw["at"]) === undefined ||
      str(raw["kind"]) === undefined ||
      str(raw["detail"]) === undefined
    ) {
      problems.push("有一条决策记录读不懂。");
      continue;
    }
    const kind = raw["kind"] as string;
    const hash = str(raw["agendaHash"]);
    audit.push({
      at: raw["at"] as number,
      // A kind 3 has no name for keeps its words, under 「导入」.
      kind: AUDIT_KINDS.has(kind) ? (kind as AuditKind) : "imported",
      detail: AUDIT_KINDS.has(kind) ? (raw["detail"] as string) : `（2.x：${kind}）${raw["detail"] as string}`,
      ...(hash === undefined ? {} : { agendaHash: hash }),
    });
  }
  const lines = (input.records ?? []).filter((line) => line.kind === SPEECH).length;
  audit.push({
    at: input.importedAt,
    kind: "imported",
    detail:
      `从 Squad 2.x 导入（${sittingOf === undefined ? "团队" : `${sittingOf} 的一场`} ${teamId}）：` +
      `${lines} 条发言、${counts.checkpoints} 个检查点。`,
  });

  if (isObject(row["seatSessions"]) && Object.keys(row["seatSessions"]).length > 0) {
    notes.push("各席位在 2.x 里接着用的 CLI 会话不带过来：每个席位下一轮重新开会话（多付一次建缓存的钱）。");
  }
  if (isObject(row["selection"])) notes.push("2.x 输入框里勾着、还没发出去的引用和资料不带过来。");
  if (finished.kind === "finished") {
    notes.push(
      `带上了已经跑完的议程（${finished.agenda.agenda.phases.length} 个阶段都已结束` +
        `${finished.agenda.reportPath === undefined ? "" : `，完成报告在 ${finished.agenda.reportPath}`}）。`,
    );
  }
  if (sittingOf !== undefined) {
    notes.push(
      `这是 2.x「${input.baseName ?? sittingOf}」的一场（同一队人、另起的讨论），导入后是那支团队下的一场会话，` +
        "名册、项目文件夹、提示词和资料跟着团队走。",
    );
  }

  // The report tells sittings apart by their start; the record carries the
  // team's own name, since a session shares it (table/sessions.ts).
  const displayName = sittingOf === undefined ? name : `${input.baseName ?? name} · ${stamp(createdAt)} 那一场`;
  const recordName = sittingOf === undefined ? name : (input.baseName ?? name);
  const checkpointCoefficient = num(row["checkpointCoefficient"]);
  return {
    teamId,
    displayName,
    ...(sittingOf === undefined ? {} : { sittingOf }),
    problems,
    notes,
    counts,
    events,
    record: {
      version: 2,
      teamId,
      displayName: recordName,
      ...(sittingOf === undefined ? {} : { baseTeamId: sittingOf }),
      projectFolder,
      hostDisplayName: host,
      seats,
      createdAt,
      usage: usageOf(row["usage"]),
      perSeat: {},
      seatSessions: {},
      ...(checkpointCoefficient === undefined ? {} : { checkpointCoefficient }),
      ...(materials.length === 0 ? {} : { materials }),
      ...(finished.kind === "finished" ? { confirmed: finished.agenda } : {}),
      audit,
    },
  };
}

/** The entry id a log event can be pointed at by, if it has one. */
/** How an event is told apart from every other one in a record, across 2.x and 3. Undefined for kinds an import never writes. */
function keyOf(event: { readonly type: string } & Record<string, unknown>): string | undefined {
  switch (event.type) {
    case "host/message":
      return `c:${String(event["commandId"])}`;
    case "seat/reply":
    case "system/note":
    case "proxy/said":
      return `e:${String(event["entryId"])}`;
    case "checkpoint/recorded":
      return `cp:${String(event["checkpointId"])}`;
    case "checkpoint/revoked":
      return `rv:${String(event["checkpointId"])}`;
    default:
      return undefined;
  }
}

/**
 * What an import can add to a session already in 3, while 2.x is still in
 * use: the lines said in 2.x since. Only when everything 3 holds for it came
 * from 2.x, in the same order — a session that was also carried on in 3 has
 * two continuations, and interleaving them by time would put each half's
 * replies under the other half's questions.
 */
export function topUp(
  existing: readonly ({ readonly type: string } & Record<string, unknown>)[],
  planned: readonly TimedEntry[],
):
  | { readonly kind: "same" }
  | { readonly kind: "newer"; readonly events: readonly TimedEntry[] }
  | { readonly kind: "diverged"; readonly reason: string } {
  const plannedKeys = planned.map((event) => keyOf(event as unknown as { type: string } & Record<string, unknown>));
  const plannedSet = new Set(plannedKeys);
  const held = existing.map(keyOf);
  const saidIn3 = held.filter((key) => key === undefined || !plannedSet.has(key)).length;
  if (saidIn3 > 0) {
    return {
      kind: "diverged",
      reason: `这一场在 3 里也接着用过（有 ${saidIn3} 条不是从 2.x 来的），两边的新内容合不到一起，不补导。`,
    };
  }
  const heldSet = new Set(held);
  // Everything 3 holds must be the start of 2.x's record, in the same order.
  const prefix = plannedKeys.filter((key) => heldSet.has(key));
  if (prefix.length !== held.length || prefix.some((key, index) => key !== held[index])) {
    return { kind: "diverged", reason: "3 里这一场的顺序跟 2.x 对不上，不补导。" };
  }
  const firstNew = plannedKeys.findIndex((key) => !heldSet.has(key));
  if (firstNew < 0) return { kind: "same" };
  if (plannedKeys.slice(firstNew).some((key) => heldSet.has(key))) {
    return { kind: "diverged", reason: "2.x 在已经导入的内容中间插进了新内容，不补导。" };
  }
  return { kind: "newer", events: planned.slice(firstNew) };
}

function entryOf(event: TimedEntry): string | undefined {
  switch (event.type) {
    case "host/message":
      return event.commandId;
    case "seat/reply":
    case "system/note":
    case "proxy/said":
      return event.entryId;
    default:
      return undefined;
  }
}
