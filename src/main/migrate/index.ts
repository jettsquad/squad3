/**
 * migrate — bringing a Squad 2.x home into 3. One way, read-only on the 2.x side.
 *
 * 3 新写，规矩继承 2.x `@squad/migrate`（设计文档 §11）：默认试运行；按团队拒绝；
 * 迁完回读；turnId 原样保留；作废状态跟着走；事件类型没有 catch-all；不动 2.x 的任何文件。
 * 凭据不导入值，只导入引用（§15 Q5）；Lil X 判据库复制一份（§15 Q6）。
 *
 * What a 2.x home holds, as 2.x 8e96d9c writes it:
 *   storages/squad_table.json            teams and sittings (domain squad_table v1)
 *   storages/squad_teams.json            checkpoints (domain squad_teams v2)
 *   storages/squad_agent_templates.json  the agent library (v1)
 *   storages/squad_connections.json      connections, by reference to a key (v1)
 *   storages/squad_settings.json         the host's name and Lil X's connection (v1)
 *   squad-records/<teamId>.jsonl         each team's record, one line per event
 *   lil-x/                               the criteria library, plain Markdown
 * The keys themselves are in dsh's credential file, which this never opens.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTemplate, SeatConnection } from "../../shared/index.ts";
import type { Library } from "../library/index.ts";
import type { Store } from "../store/index.ts";
import type { Table } from "../table/index.ts";
import { planTeam, topUp, type CheckpointRow, type RecordLine, type TeamPlan, type TimedEntry } from "./plan.ts";

export { CARRIES_NOTHING, planTeam, splitSpeaker, splitTag, topUp, type TeamPlan } from "./plan.ts";

/** Where 2.x keeps its home when nothing says otherwise. */
export const DEFAULT_2X_HOME = join(homedir(), ".dsh");

/** The storage units this reads, and the one version of each it understands. */
const UNITS = {
  table: { file: "squad_table.json", name: "squad_table", version: 1 },
  teams: { file: "squad_teams.json", name: "squad_teams", version: 2 },
  agents: { file: "squad_agent_templates.json", name: "squad_agent_templates", version: 1 },
  connections: { file: "squad_connections.json", name: "squad_connections", version: 1 },
  settings: { file: "squad_settings.json", name: "squad_settings", version: 1 },
} as const;

type Unit = keyof typeof UNITS;

/** One team, as the report shows it. */
export interface TeamReport {
  readonly teamId: string;
  readonly displayName: string;
  readonly projectFolder: string;
  readonly sittingOf?: string | undefined;
  readonly lines: number;
  readonly checkpoints: number;
  /**
   * importable · refused · already (in 3, nothing new) · newer (in 3, and 2.x
   * has said more since: `newLines` of it can be added) · imported · updated
   * (topped up) · failed (refused at read-back)
   */
  readonly status: "importable" | "refused" | "already" | "newer" | "imported" | "updated" | "failed";
  readonly newLines?: number | undefined;
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

export interface LibraryReport {
  readonly label: string;
  readonly id: string;
  readonly status: "importable" | "already" | "refused" | "imported";
  readonly detail?: string | undefined;
}

export interface MigrationReport {
  readonly home: string;
  /** Nothing written: what an import WOULD do. */
  readonly dryRun: boolean;
  /** Whole-home problems: a storage file missing or of an unknown version. */
  readonly problems: readonly string[];
  readonly teams: readonly TeamReport[];
  readonly agents: readonly LibraryReport[];
  readonly connections: readonly LibraryReport[];
  readonly settings: readonly string[];
  readonly criteria: { readonly files: number; readonly already: number; readonly copied: number };
}

export interface Migrator {
  /** What an import would do. Writes nothing. */
  scan(home?: string): MigrationReport;
  /** Import everything importable that is not in 3 yet, then read each team back. */
  run(home?: string): MigrationReport;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One storage unit's table rows, or why it cannot be read. */
function readUnit(home: string, unit: Unit): { rows: Record<string, Record<string, unknown>>; problem?: string } {
  const spec = UNITS[unit];
  const path = join(home, "storages", spec.file);
  if (!existsSync(path)) return { rows: {}, problem: `没有 ${spec.file}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { rows: {}, problem: `${spec.file} 不是合法的 JSON` };
  }
  const head = isObject(parsed) && isObject(parsed["unit"]) ? parsed["unit"] : undefined;
  if (head?.["name"] !== spec.name || head["version"] !== spec.version) {
    return {
      rows: {},
      problem: `${spec.file} 的格式是 ${String(head?.["name"])} v${String(head?.["version"])}，这一版只认 ${spec.name} v${spec.version}`,
    };
  }
  const tables = isObject(parsed) && isObject(parsed["tables"]) ? parsed["tables"] : {};
  const tableName = {
    table: "teams",
    teams: "checkpoints",
    agents: "templates",
    connections: "connections",
    settings: "settings",
  }[unit];
  const rows = isObject(tables[tableName]) ? (tables[tableName] as Record<string, unknown>) : {};
  return {
    rows: Object.fromEntries(
      Object.entries(rows).filter((entry): entry is [string, Record<string, unknown>] => isObject(entry[1])),
    ),
  };
}

/** A record file, or undefined when there is none. Throws, naming the line, when a line is not a record. */
function readRecords(home: string, teamId: string): RecordLine[] | undefined {
  const path = join(home, "squad-records", `${teamId}.jsonl`);
  if (!existsSync(path)) return undefined;
  const lines: RecordLine[] = [];
  for (const [index, text] of readFileSync(path, "utf8").split("\n").entries()) {
    if (text.trim() === "") continue;
    const parsed = JSON.parse(text) as Partial<RecordLine>;
    if (
      typeof parsed.turnId !== "string" ||
      typeof parsed.kind !== "string" ||
      typeof parsed.at !== "number" ||
      typeof parsed.text !== "string"
    ) {
      throw new Error(`squad-records/${teamId}.jsonl 第 ${index + 1} 行不是一条记录。`);
    }
    lines.push({ turnId: parsed.turnId, kind: parsed.kind, at: parsed.at, text: parsed.text });
  }
  return lines;
}

/** Every file under a folder, relative to it. */
function filesUnder(root: string, relative = ""): string[] {
  const here = join(root, relative);
  if (!existsSync(here)) return [];
  return readdirSync(here).flatMap((name) => {
    const path = join(relative, name);
    return statSync(join(root, path)).isDirectory() ? filesUnder(root, path) : [path];
  });
}

/** The template a 2.x agent row becomes. 2.x keeps `createdAt` as storage bookkeeping; 3 does not. */
function templateOf(row: Record<string, unknown>): AgentTemplate {
  const { createdAt: _createdAt, ...rest } = row;
  return rest as unknown as AgentTemplate;
}

function connectionOf(row: Record<string, unknown>): SeatConnection {
  const { createdAt: _createdAt, ...rest } = row;
  return rest as unknown as SeatConnection;
}

export function createMigrator(deps: {
  readonly store: Store;
  readonly library: Pick<Library, "agents" | "connections" | "settings">;
  readonly table: Pick<Table, "list" | "adopt" | "reload">;
  /** Lil X's library folder in 3, read at each call. */
  readonly criteriaFolder: () => string;
  readonly now?: () => number;
}): Migrator {
  const now = deps.now ?? Date.now;

  const plan = (home: string) => {
    const problems: string[] = [];
    const units = Object.fromEntries(
      (Object.keys(UNITS) as Unit[]).map((unit) => {
        const read = readUnit(home, unit);
        if (read.problem !== undefined) problems.push(`${read.problem}。`);
        return [unit, read.rows];
      }),
    ) as Record<Unit, Record<string, Record<string, unknown>>>;

    const checkpoints = Object.values(units.teams) as unknown as CheckpointRow[];
    const importedAt = now();
    const have = new Set(deps.table.list().teams.map((team) => team.teamId));
    const teams: { plan: TeamPlan; report: TeamReport; more?: readonly TimedEntry[] }[] = [];
    for (const [teamId, row] of Object.entries(units.table)) {
      let records: RecordLine[] | undefined;
      let readProblem: string | undefined;
      try {
        records = readRecords(home, teamId);
      } catch (error) {
        readProblem = error instanceof Error ? error.message : String(error);
      }
      const base = typeof row["baseTeamId"] === "string" ? units.table[row["baseTeamId"]] : undefined;
      const planned = planTeam({
        row,
        records: readProblem === undefined ? records : [],
        checkpoints: checkpoints.filter((checkpoint) => checkpoint.teamId === teamId),
        ...(typeof base?.["displayName"] === "string" ? { baseName: base["displayName"] } : {}),
        importedAt,
      });
      const teamProblems = readProblem === undefined ? planned.problems : [readProblem, ...planned.problems];
      const already = have.has(teamId) || deps.store.loadTeam(teamId) !== undefined;
      // Already in 3: is there more in 2.x since, and can it be added on?
      const more =
        already && teamProblems.length === 0 && have.has(teamId)
          ? topUp(deps.store.logFor(teamId).read() as unknown as Parameters<typeof topUp>[0], planned.events)
          : undefined;
      teams.push({
        plan: planned,
        ...(more?.kind === "newer" ? { more: more.events } : {}),
        report: {
          teamId,
          displayName: planned.displayName,
          projectFolder: planned.record.projectFolder,
          ...(planned.sittingOf === undefined ? {} : { sittingOf: planned.sittingOf }),
          lines: planned.counts.host + planned.counts.seat + planned.counts.system + planned.counts.proxy,
          checkpoints: planned.counts.checkpoints,
          status:
            more?.kind === "newer" ? "newer" : already ? "already" : teamProblems.length > 0 ? "refused" : "importable",
          ...(more?.kind === "newer" ? { newLines: more.events.length } : {}),
          problems: teamProblems,
          notes: more?.kind === "diverged" ? [...planned.notes, more.reason] : planned.notes,
        },
      });
    }

    const agents: LibraryReport[] = Object.entries(units.agents).map(([id, row]) => ({
      label: String(row["displayName"] ?? id),
      id,
      status: deps.library.agents.get(id) !== undefined ? "already" : "importable",
    }));
    const connections: LibraryReport[] = Object.entries(units.connections).map(([id, row]) => ({
      label: String(row["displayName"] ?? id),
      id,
      status: deps.library.connections.get(id) !== undefined ? "already" : "importable",
      ...(row["authMode"] === "api-key" ? { detail: "密钥不带过来，导入后要在「连接」里重新填一次" } : {}),
    }));

    const me = units.settings["me"] ?? {};
    const current = deps.library.settings.get();
    const settings: string[] = [];
    if (typeof me["hostDisplayName"] === "string" && (current.hostDisplayName ?? "") === "") {
      settings.push(`主持人名字：${me["hostDisplayName"]}`);
    }
    if (typeof me["distilConnectionId"] === "string" && (current.distilConnectionId ?? "") === "") {
      settings.push(`Lil X 用的连接：${me["distilConnectionId"]}`);
    }

    const criteriaFrom = join(home, "lil-x");
    const criteriaFiles = filesUnder(criteriaFrom);
    const criteriaTo = deps.criteriaFolder();
    const criteriaAlready = criteriaFiles.filter((file) => existsSync(join(criteriaTo, file))).length;

    return {
      problems,
      teams,
      agents,
      connections,
      me,
      settings,
      criteriaFrom,
      criteriaFiles,
      criteriaTo,
      criteriaAlready,
    };
  };

  const report = (
    home: string,
    dryRun: boolean,
    planned: ReturnType<typeof plan>,
    outcome: {
      teams?: ReadonlyMap<string, TeamReport>;
      agents?: ReadonlyMap<string, LibraryReport>;
      connections?: ReadonlyMap<string, LibraryReport>;
      copied?: number;
    } = {},
  ): MigrationReport => ({
    home,
    dryRun,
    problems: planned.problems,
    teams: planned.teams.map((team) => outcome.teams?.get(team.report.teamId) ?? team.report),
    agents: planned.agents.map((agent) => outcome.agents?.get(agent.id) ?? agent),
    connections: planned.connections.map((connection) => outcome.connections?.get(connection.id) ?? connection),
    settings: planned.settings,
    criteria: { files: planned.criteriaFiles.length, already: planned.criteriaAlready, copied: outcome.copied ?? 0 },
  });

  const homeOf = (home: string | undefined): string => {
    const chosen = (home ?? "").trim() === "" ? DEFAULT_2X_HOME : (home as string).trim();
    if (!existsSync(join(chosen, "storages"))) {
      throw new Error(`「${chosen}」不像 Squad 2.x 的数据目录：里面没有 storages 文件夹。`);
    }
    return chosen;
  };

  return {
    scan: (home) => {
      const chosen = homeOf(home);
      return report(chosen, true, plan(chosen));
    },

    run: (home) => {
      const chosen = homeOf(home);
      const planned = plan(chosen);

      // The library first: an imported seat names its agent and its connection.
      const agents = new Map<string, LibraryReport>();
      for (const agent of planned.agents) {
        if (agent.status !== "importable") continue;
        try {
          deps.library.agents.save(templateOf(readUnit(chosen, "agents").rows[agent.id] ?? {}));
          agents.set(agent.id, { ...agent, status: "imported" });
        } catch (error) {
          agents.set(agent.id, {
            ...agent,
            status: "refused",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const connections = new Map<string, LibraryReport>();
      for (const connection of planned.connections) {
        if (connection.status !== "importable") continue;
        try {
          // The reference travels, the value does not (§15 Q5): the connection
          // shows 「密钥未配置」 until the key is entered once in 3.
          deps.library.connections.save(connectionOf(readUnit(chosen, "connections").rows[connection.id] ?? {}));
          connections.set(connection.id, { ...connection, status: "imported" });
        } catch (error) {
          connections.set(connection.id, {
            ...connection,
            status: "refused",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (planned.settings.length > 0) {
        const current = deps.library.settings.get();
        deps.library.settings.save({
          ...((current.hostDisplayName ?? "") === "" && typeof planned.me["hostDisplayName"] === "string"
            ? { hostDisplayName: planned.me["hostDisplayName"] }
            : {}),
          ...((current.distilConnectionId ?? "") === "" && typeof planned.me["distilConnectionId"] === "string"
            ? { distilConnectionId: planned.me["distilConnectionId"] }
            : {}),
        });
      }

      // Lil X: copied (§15 Q6), never overwriting a file 3 already has.
      let copied = 0;
      for (const file of planned.criteriaFiles) {
        const to = join(planned.criteriaTo, file);
        if (existsSync(to)) continue;
        mkdirSync(join(to, ".."), { recursive: true });
        copyFileSync(join(planned.criteriaFrom, file), to);
        copied += 1;
      }

      // Teams, each on its own: one that fails does not stop the next.
      const teams = new Map<string, TeamReport>();
      // Sessions already in 3 that 2.x has carried on: the new lines go on the
      // end, and the usage is 2.x's current total. Name, archive state and
      // everything 3 added to the record stay as they are.
      for (const { plan: team, report: before, more } of planned.teams) {
        if (before.status !== "newer" || more === undefined) continue;
        try {
          const held = deps.store.loadTeam<Record<string, unknown>>(team.teamId);
          if (held === undefined) throw new Error("3 里找不到这一场了。");
          const log = deps.store.logFor(team.teamId);
          const count = log.read().length;
          deps.store.saveTeam(team.teamId, { ...held, usage: team.record.usage });
          for (const { at, ...entry } of more) log.append(entry, at);
          const read = deps.store.logFor(team.teamId).read().length;
          if (read !== count + more.length) throw new Error(`补了 ${more.length} 条，读回来多了 ${read - count} 条。`);
          deps.table.reload(team.teamId);
          teams.set(team.teamId, { ...before, status: "updated" });
        } catch (error) {
          teams.set(team.teamId, {
            ...before,
            status: "failed",
            problems: [...before.problems, `补导失败：${error instanceof Error ? error.message : String(error)}`],
          });
        }
      }
      for (const { plan: team, report: before } of planned.teams) {
        if (before.status !== "importable") continue;
        try {
          deps.store.saveTeam(team.teamId, team.record);
          const log = deps.store.logFor(team.teamId);
          for (const { at, ...entry } of team.events) log.append(entry, at);
          // The read-back: its lines counted against what was written, then
          // the team taken up exactly as a restart would take it.
          const read = deps.store.logFor(team.teamId).read();
          if (read.length !== team.events.length) {
            throw new Error(`写进去 ${team.events.length} 条，读回来 ${read.length} 条。`);
          }
          deps.table.adopt(team.teamId);
          teams.set(team.teamId, { ...before, status: "imported" });
        } catch (error) {
          // Nothing half-written left behind: a folder that is there but not
          // taken up would read as 「已经导入过」 on the next run.
          if (!deps.table.list().teams.some((one) => one.teamId === team.teamId)) deps.store.discardTeam(team.teamId);
          teams.set(team.teamId, {
            ...before,
            status: "failed",
            problems: [...before.problems, `导入后读不回来：${error instanceof Error ? error.message : String(error)}`],
          });
        }
      }
      return report(chosen, false, planned, { teams, agents, connections, copied });
    },
  };
}
