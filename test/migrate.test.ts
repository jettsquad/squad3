/**
 * Importing a Squad 2.x home: dry run first, refusal per team, turn ids and
 * revocation carried, nothing written on the 2.x side, and every imported
 * team read back the way a restart would read it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/main/context/index.ts";
import { createLibrary } from "../src/main/library/index.ts";
import { createMigrator } from "../src/main/migrate/index.ts";
import { resetSeatSessions } from "../src/main/seat-runtime/index.ts";
import type { Seats } from "../src/main/seats/index.ts";
import { createSecretary } from "../src/main/secretary/index.ts";
import { createStore } from "../src/main/store/index.ts";
import { createTable, type Table } from "../src/main/table/index.ts";
import { createVault, type Cipher } from "../src/main/vault/index.ts";

afterEach(() => resetSeatSessions());

const cipher: Cipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(plain, "utf8").reverse(),
  decrypt: (sealed) => Buffer.from(sealed).reverse().toString("utf8"),
};

const at = (minute: number): number => new Date(2026, 9, 20, 10, minute).getTime();
const line = (turnId: string, minute: number, text: string, kind = "user/message") =>
  JSON.stringify({ turnId, kind, at: at(minute), text });
const unit = (name: string, version: number, table: string, rows: Record<string, unknown>) =>
  JSON.stringify({ unit: { name, version }, global: null, tables: { [table]: rows } });

const seat = (seatId: string, displayName: string, extra: Record<string, unknown> = {}) => ({
  seatId,
  displayName,
  role: "工程师",
  systemPrompt: `我是${displayName}。`,
  backend: "claude-code",
  ...extra,
});

/** A 2.x home: a base team with a sitting, and a second team that cannot be read. */
function home2x(): string {
  const home = mkdtempSync(join(tmpdir(), "squad2x-"));
  const project = mkdtempSync(join(tmpdir(), "squad2x-project-"));
  mkdirSync(join(home, "storages"));
  mkdirSync(join(home, "squad-records"));
  mkdirSync(join(home, "lil-x", "criteria"), { recursive: true });
  writeFileSync(join(home, "lil-x", "criteria", "c-1.md"), "# 判据\n");
  const base = {
    teamId: "team-a",
    sessionId: "s-1",
    displayName: "评审组",
    projectFolder: project,
    hostDisplayName: "主持人",
    seats: [seat("seat-1", "甲", { isSecretary: true, templateId: "agent-1" }), seat("seat-2", "乙")],
    usage: { turns: 3, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.5 },
    seatSessions: { "seat-1": { id: "x" } },
    audit: [{ at: at(1), kind: "agenda-confirmed", detail: "确认了议程" }],
    createdAt: at(0),
  };
  writeFileSync(
    join(home, "storages", "squad_table.json"),
    unit("squad_table", 1, "teams", {
      "team-a": base,
      "sit-a": {
        ...base,
        teamId: "sit-a",
        sessionId: "s-2",
        baseTeamId: "team-a",
        audit: undefined,
        createdAt: at(30),
      },
      "team-b": { ...base, teamId: "team-b", displayName: "坏的", audit: undefined },
    }),
  );
  writeFileSync(
    join(home, "squad-records", "team-a.jsonl"),
    [
      line("seq-0", 0, "", "permission/preset"),
      line("h1", 1, "【主持人】大家说说"),
      line("r1", 2, "【甲】我看行"),
      line("r2", 3, "【乙】⚠️ 该席位未能执行：超时"),
      line("h2", 4, "【主持人】@甲 再想想"),
      line("n1", 5, "【系统】⏹ 甲 被叫停"),
      line("r3", 6, "【Joker】我是以前的秘书"),
      line("r4", 7, "【乙】（答 10:01「大家说说」）\n补一句"),
      line("p1", 8, "【Lil X（代主持人）】我替你定了"),
    ].join("\n") + "\n",
  );
  writeFileSync(join(home, "squad-records", "sit-a.jsonl"), [line("h9", 31, "【主持人】新的一场")].join("\n") + "\n");
  writeFileSync(
    join(home, "squad-records", "team-b.jsonl"),
    [line("h1", 1, "【主持人】你好"), line("x", 2, "{}", "something/new")].join("\n") + "\n",
  );
  writeFileSync(
    join(home, "storages", "squad_teams.json"),
    JSON.stringify({
      unit: { name: "squad_teams", version: 2 },
      global: null,
      tables: {
        checkpoints: {
          "cp-1": {
            teamId: "team-a",
            checkpointId: "cp-1",
            text: "## 结论\n要点",
            coversUpTo: "r2",
            createdAt: at(3) + 1000,
          },
          "cp-2": {
            teamId: "team-a",
            checkpointId: "cp-2",
            text: "## 结论\n作废的那个",
            coversUpTo: "n1",
            createdAt: at(5) + 1000,
            revokedAt: at(6) + 1000,
          },
        },
        artifacts: {},
      },
    }),
  );
  writeFileSync(
    join(home, "storages", "squad_agent_templates.json"),
    unit("squad_agent_templates", 1, "templates", {
      "agent-1": {
        templateId: "agent-1",
        displayName: "甲",
        role: "工程师",
        systemPrompt: "我是甲。",
        backend: "claude-code",
        secretaryCandidate: true,
        color: "#2e7d6b",
        enabled: true,
        createdAt: at(0),
      },
    }),
  );
  writeFileSync(
    join(home, "storages", "squad_connections.json"),
    unit("squad_connections", 1, "connections", {
      "conn-1": {
        connectionId: "conn-1",
        displayName: "网关",
        authMode: "api-key",
        backend: "claude-code",
        endpoint: "https://api.example.test/anthropic",
        credentialRef: "SQUAD_CONN_1_KEY",
        createdAt: at(0),
      },
    }),
  );
  writeFileSync(
    join(home, "storages", "squad_settings.json"),
    unit("squad_settings", 1, "settings", { me: { hostDisplayName: "阿明", updatedAt: at(0) } }),
  );
  return home;
}

function app() {
  const dataDir = mkdtempSync(join(tmpdir(), "squad3-"));
  const store = createStore(dataDir);
  const library = createLibrary({ dataDir, vault: createVault({ dataDir, cipher, env: {} }) });
  const seats: Seats = { adapterFor: () => "测试里不跑席位。" };
  const late: { table?: Table } = {};
  const context = createContext({
    store,
    secretary: createSecretary(seats),
    facts: (teamId) => (late.table as Table).facts(teamId),
    onFolded: (teamId) => (late.table as Table).folded(teamId),
    onChanged: () => undefined,
  });
  const table = createTable({
    store,
    seats,
    context,
    onChanged: () => undefined,
    library: {
      template: (id) => library.agents.get(id),
      hasConnection: (id) => library.connections.get(id),
      resolveConnection: () => {
        throw new Error("无");
      },
      hostDisplayName: () => library.settings.get().hostDisplayName,
    },
  });
  late.table = table;
  const migrator = createMigrator({
    store,
    library,
    table,
    criteriaFolder: () => join(dataDir, "criteria"),
    now: () => at(59),
  });
  return { dataDir, store, library, table, migrator };
}

/** Every file under a folder with its hash: the 2.x side must not change by one byte. */
const fingerprint = (root: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, `${statSync(path).mtimeMs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`];
      }),
  );

describe("dry run", () => {
  it("says what would come and what would not, and writes nothing", () => {
    const home = home2x();
    const { migrator, dataDir, table } = app();
    const report = migrator.scan(home);
    expect(report.dryRun).toBe(true);
    expect(report.problems).toEqual([]);
    const byId = Object.fromEntries(report.teams.map((team) => [team.teamId, team]));
    expect(byId["team-a"]).toMatchObject({ status: "importable", lines: 8, checkpoints: 2 });
    expect(byId["sit-a"]).toMatchObject({ status: "importable", sittingOf: "team-a" });
    expect(byId["sit-a"]?.displayName).toMatch(/^评审组 · 10-20 10:30 那一场$/);
    expect(byId["team-b"]?.status).toBe("refused");
    expect(byId["team-b"]?.problems.join()).toMatch(/类型「something\/new」不认识/);
    expect(byId["team-a"]?.notes.join()).toMatch(/「Joker」.*已离席的成员/);
    expect(report.connections[0]?.detail).toMatch(/密钥不带过来/);
    expect(report.settings).toEqual(["主持人名字：阿明"]);
    expect(report.criteria).toEqual({ files: 1, already: 0, copied: 0 });
    expect(table.list().teams).toEqual([]);
    expect(readdirSync(dataDir).filter((name) => name === "teams")).toEqual([]);
  });

  it("refuses a storage file of a version it does not know, by name", () => {
    const home = home2x();
    writeFileSync(join(home, "storages", "squad_teams.json"), unit("squad_teams", 3, "checkpoints", {}));
    const report = app().migrator.scan(home);
    expect(report.problems.join()).toMatch(/squad_teams v3，这一版只认 squad_teams v2/);
  });
});

describe("import", () => {
  it("carries the record with its ids, its checkpoints and their revocation; refuses only the team it cannot read", () => {
    const home = home2x();
    const before = fingerprint(home);
    const { migrator, table, store } = app();
    const report = migrator.run(home);
    expect(report.dryRun).toBe(false);
    expect(Object.fromEntries(report.teams.map((team) => [team.teamId, team.status]))).toEqual({
      "team-a": "imported",
      "sit-a": "imported",
      "team-b": "refused",
    });
    expect(fingerprint(home)).toEqual(before);

    const lines = table.transcript("team-a");
    expect(lines.filter((one) => one.kind !== "checkpoint").map((one) => [one.kind, one.speaker, one.entryId])).toEqual(
      [
        ["host", "主持人", "h1"],
        ["seat", "甲", "r1"],
        ["seat", "乙", "r2"],
        ["host", "主持人", "h2"],
        ["system", "系统", "n1"],
        ["seat", "Joker", "r3"],
        ["seat", "乙", "r4"],
        ["proxy", "Lil X（代主持人）", "p1"],
      ],
    );
    // Said when it was said, not when it was imported.
    expect(lines[0]?.at).toBe(at(1));
    const events = store.logFor("team-a").read();
    const reply = (entryId: string) => events.find((event) => event.type === "seat/reply" && event.entryId === entryId);
    expect(reply("r2")).toMatchObject({ failed: true, commandId: "h1" });
    // A tagged reply answers the command its tag names, not the latest one.
    expect(reply("r4")).toMatchObject({ commandId: "h1", text: "补一句" });
    expect(reply("r3")).toMatchObject({ seatId: "former-1", commandId: "h2" });
    expect(events.find((event) => event.type === "checkpoint/recorded" && event.checkpointId === "cp-1")).toMatchObject(
      {
        coversUpTo: "r2",
      },
    );
    expect(events.some((event) => event.type === "checkpoint/revoked" && event.checkpointId === "cp-2")).toBe(true);

    const team = table.list().teams.find((one) => one.teamId === "team-a");
    expect(team?.usage.costUsd).toBe(0.5);
    expect(team?.audit.map((entry) => entry.kind)).toEqual(["agenda-confirmed", "imported"]);
    // A 2.x sitting arrives as a session of its team, not a team of its own.
    expect(table.list().teams.find((one) => one.teamId === "sit-a")).toMatchObject({
      groupId: "team-a",
      displayName: team?.displayName,
      sessionCount: 2,
    });
  });

  it("brings the library and settings, keys excepted, and Lil X's files", () => {
    const home = home2x();
    const { migrator, library, dataDir } = app();
    migrator.run(home);
    expect(library.agents.get("agent-1")?.displayName).toBe("甲");
    expect(library.connections.views().find((view) => view.connectionId === "conn-1")).toMatchObject({
      credentialRef: "SQUAD_CONN_1_KEY",
      credentialConfigured: false,
    });
    expect(library.settings.get().hostDisplayName).toBe("阿明");
    expect(readFileSync(join(dataDir, "criteria", "criteria", "c-1.md"), "utf8")).toBe("# 判据\n");
  });

  it("run twice, the second time brings nothing and says so", () => {
    const home = home2x();
    const { migrator } = app();
    migrator.run(home);
    const again = migrator.run(home);
    expect(again.teams.filter((team) => team.teamId !== "team-b").every((team) => team.status === "already")).toBe(
      true,
    );
    expect(again.agents.every((agent) => agent.status === "already")).toBe(true);
    expect(again.criteria).toEqual({ files: 1, already: 1, copied: 0 });
  });

  it("adds what 2.x said since to a session already imported, and keeps what 3 changed on it", () => {
    const home = home2x();
    const { migrator, table } = app();
    migrator.run(home);
    table.renameSession("sit-a", "复盘");
    // 2.x is still in use: two more lines in the sitting.
    writeFileSync(
      join(home, "squad-records", "sit-a.jsonl"),
      [line("h9", 31, "【主持人】新的一场"), line("h10", 40, "【主持人】接着说"), line("r10", 41, "【甲】好的")].join(
        "\n",
      ) + "\n",
    );
    const scan = migrator.scan(home);
    expect(scan.teams.find((team) => team.teamId === "sit-a")).toMatchObject({ status: "newer", newLines: 2 });
    expect(scan.teams.find((team) => team.teamId === "team-a")?.status).toBe("already");

    const run = migrator.run(home);
    expect(run.teams.find((team) => team.teamId === "sit-a")?.status).toBe("updated");
    expect(table.transcript("sit-a").map((one) => one.entryId)).toEqual(["h9", "h10", "r10"]);
    expect(table.list().teams.find((one) => one.teamId === "sit-a")).toMatchObject({ sessionLabel: "复盘" });
    expect(migrator.scan(home).teams.find((team) => team.teamId === "sit-a")?.status).toBe("already");
  });

  it("does not top up a session that was also carried on in 3, and says why", () => {
    const home = home2x();
    const { migrator, table } = app();
    migrator.run(home);
    table.recordNote("sit-a", "在 3 里说的");
    writeFileSync(
      join(home, "squad-records", "sit-a.jsonl"),
      [line("h9", 31, "【主持人】新的一场"), line("h10", 40, "【主持人】接着说")].join("\n") + "\n",
    );
    const scan = migrator.scan(home);
    const sitting = scan.teams.find((team) => team.teamId === "sit-a");
    expect(sitting?.status).toBe("already");
    expect(sitting?.notes.join()).toMatch(/在 3 里也接着用过/);
  });

  it("carries an agenda that finished in 2.x, and refuses one still mid-run", () => {
    const finishedRow = (state: string) => ({
      confirmed: {
        hostGoal: "评审",
        phases: [
          {
            id: "P1",
            title: "初审",
            purpose: "看一遍",
            contextMode: "independent",
            tasks: [{ seatId: "seat-1", instruction: "甲初审" }],
          },
          {
            id: "P2",
            title: "定稿",
            purpose: "收尾",
            contextMode: "independent",
            tasks: [{ seatId: "seat-1", instruction: "甲定稿" }],
          },
        ],
      },
      confirmedAt: at(20),
      confirmedDone: ["初审"],
      confirmedNodes: { P1: { state: "passed", attempts: 1 }, P2: { state, attempts: 1 } },
      confirmedProxy: true,
      confirmedDecisions: [
        { at: at(21), nodeId: "P1", title: "初审", problem: "甲没写完", action: "retry", detail: "重做" },
      ],
      confirmedReportPath: ".squad/reports/r.md",
      confirmedHash: "abc",
      confirmedRoster: [{ seatId: "seat-1", displayName: "甲", role: "工程师" }],
    });
    const withAgenda = (state: string): string => {
      const home = home2x();
      const path = join(home, "storages", "squad_table.json");
      const doc = JSON.parse(readFileSync(path, "utf8")) as { tables: { teams: Record<string, object> } };
      doc.tables.teams["sit-a"] = { ...doc.tables.teams["sit-a"], ...finishedRow(state) };
      writeFileSync(path, JSON.stringify(doc));
      return home;
    };

    const running = app()
      .migrator.scan(withAgenda("running"))
      .teams.find((team) => team.teamId === "sit-a");
    expect(running?.status).toBe("refused");
    expect(running?.problems).toHaveLength(1);
    expect(running?.problems[0]).toMatch(/议程还没跑完（「定稿」running）/);

    const { migrator, table } = app();
    const report = migrator.run(withAgenda("passed"));
    const sitting = report.teams.find((team) => team.teamId === "sit-a");
    expect(sitting?.status).toBe("imported");
    expect(sitting?.notes.join()).toMatch(
      /带上了已经跑完的议程（2 个阶段都已结束，完成报告在 \.squad\/reports\/r\.md）/,
    );
    const confirmed = table.list().teams.find((one) => one.teamId === "sit-a")?.agenda.confirmed;
    expect(confirmed).toMatchObject({ proxy: true, standing: "finished" });
    expect(confirmed?.nodes.map((node) => node.state)).toEqual(["passed", "passed"]);
    expect(confirmed?.decisions).toHaveLength(1);
  });

  it("a home that is not one is refused before anything is read", () => {
    expect(() => app().migrator.scan(mkdtempSync(join(tmpdir(), "not2x-")))).toThrow(/不像 Squad 2.x 的数据目录/);
  });
});
