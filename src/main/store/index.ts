/**
 * store — where a team lives on disk (design doc §6).
 *
 *   <dataDir>/teams/<teamId>/team.json   who the team is: name, folder, roster, usage
 *   <dataDir>/teams/<teamId>/log.jsonl   what happened, append-only
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic.ts";
import { TeamLog } from "./team-log.ts";

export { writeFileAtomic, writeJsonAtomic } from "./atomic.ts";
export { TeamLog } from "./team-log.ts";

export interface Store {
  /** Every team record on disk, with the ones that could not be read reported rather than dropped. */
  loadTeams<T>(): { readonly teams: readonly T[]; readonly problems: readonly string[] };
  /** One team's record, or undefined when there is no such team on disk. Throws when it is there and unreadable. */
  loadTeam<T>(teamId: string): T | undefined;
  saveTeam(teamId: string, record: unknown): void;
  logFor(teamId: string): TeamLog;
  /**
   * Remove a team folder for good: an import this process just wrote and
   * could not read back, or an archived team or session the person chose to
   * delete (only ever from the archive — a team in use is archived first).
   */
  discardTeam(teamId: string): void;
}

export function createStore(dataDir: string): Store {
  const teamsDir = join(dataDir, "teams");
  const logs = new Map<string, TeamLog>();
  return {
    loadTeams<T>() {
      if (!existsSync(teamsDir)) return { teams: [], problems: [] };
      const teams: T[] = [];
      const problems: string[] = [];
      for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(teamsDir, entry.name, "team.json");
        try {
          teams.push(JSON.parse(readFileSync(file, "utf8")) as T);
        } catch (error) {
          // Reported and skipped, never silently dropped: a team that failed
          // to load and a team that never existed must not look the same.
          problems.push(`团队「${entry.name}」没能载入：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { teams, problems };
    },
    loadTeam<T>(teamId: string) {
      const file = join(teamsDir, teamId, "team.json");
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
    },
    saveTeam(teamId, record) {
      writeJsonAtomic(join(teamsDir, teamId, "team.json"), record);
    },
    discardTeam(teamId) {
      logs.delete(teamId);
      rmSync(join(teamsDir, teamId), { recursive: true, force: true });
    },
    logFor(teamId) {
      let log = logs.get(teamId);
      if (log === undefined) {
        log = new TeamLog(join(teamsDir, teamId, "log.jsonl"));
        logs.set(teamId, log);
      }
      return log;
    },
  };
}
