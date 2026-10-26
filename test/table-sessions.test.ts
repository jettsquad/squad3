/**
 * Sessions: several discussions for one team (2.x 「场次」). Each has its own
 * record, usage and CLI conversations; the roster, folder, prompts, material,
 * name and fold threshold are the team's and stay the same in every session.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/main/context/index.ts";
import { resetSeatSessions, type SeatResult } from "../src/main/seat-runtime/index.ts";
import type { SeatAdapter, Seats } from "../src/main/seats/index.ts";
import { createSecretary } from "../src/main/secretary/index.ts";
import { createStore, type Store } from "../src/main/store/index.ts";
import { createTable, type Table, type TeamRecord } from "../src/main/table/index.ts";
import { legacySittingBase, sessionLabel } from "../src/main/table/sessions.ts";

afterEach(() => resetSeatSessions());

/** Answers at once, or holds every answer until `release` is called. */
function fakeSeats(): { seats: Seats; hold: () => void; release: () => void } {
  let held: (() => void)[] | undefined;
  const adapter: SeatAdapter = {
    backend: "claude-code",
    capabilities: { persona: true, resume: true },
    start: () => {
      const answer: SeatResult = {
        text: "好",
        failed: false,
        cancelled: false,
        exitCode: 0,
        durationMs: 1,
        usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
      const result = new Promise<SeatResult>((resolve) => {
        if (held === undefined) resolve(answer);
        else held.push(() => resolve(answer));
      });
      return { result, cancel: () => undefined };
    },
  };
  return {
    seats: { adapterFor: () => adapter },
    hold: () => {
      held = [];
    },
    release: () => {
      for (const resolve of held ?? []) resolve();
      held = undefined;
    },
  };
}

function build(store: Store, seats: Seats): Table {
  const late: { table?: Table } = {};
  const context = createContext({
    store,
    secretary: createSecretary(seats),
    facts: (teamId) => (late.table as Table).facts(teamId),
    onFolded: (teamId) => (late.table as Table).folded(teamId),
    onChanged: () => undefined,
  });
  late.table = createTable({ store, seats, context, onChanged: () => undefined });
  return late.table;
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-data-"));
  const projectFolder = mkdtempSync(join(tmpdir(), "squad-project-"));
  const store = createStore(dataDir);
  const fake = fakeSeats();
  const table = build(store, fake.seats);
  const { teamId } = table.create({
    displayName: "评审组",
    projectFolder,
    seats: [
      { displayName: "甲", role: "架构", backend: "claude-code", systemPrompt: "简明。" },
      { displayName: "乙", role: "测试", backend: "claude-code", systemPrompt: "简明。", isSecretary: true },
    ],
  });
  return { dataDir, projectFolder, store, table, teamId, ...fake };
}

const summaryOf = (table: Table, teamId: string) => {
  const team = table.list().teams.find((one) => one.teamId === teamId);
  if (team === undefined) throw new Error(`no ${teamId}`);
  return team;
};

async function idle(table: Table, teamId: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const team = summaryOf(table, teamId);
    if (!team.busy && team.commands.every((command) => command.state !== "queued" && command.state !== "running"))
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("团队一直没有安静下来。");
}

describe("sessions of a team", () => {
  it("open with the team's roster and folder, and a discussion of their own", async () => {
    const { table, teamId } = setup();
    table.say(teamId, "第一场的话");
    await idle(table, teamId);

    const { teamId: second } = table.openSession(teamId);
    const first = summaryOf(table, teamId);
    const next = summaryOf(table, second);
    expect(next).toMatchObject({ groupId: teamId, displayName: "评审组", sessionCount: 2 });
    expect(next.projectFolder).toBe(first.projectFolder);
    expect(next.seats.map((seat) => seat.seatId)).toEqual(first.seats.map((seat) => seat.seatId));
    expect(next.sessionLabel).toMatch(/^第 2 场 · /);
    expect(first.sessionLabel).toMatch(/^第 1 场 · /);
    // Its own record: the first session's words stay in the first.
    expect(table.transcript(second).filter((line) => line.kind !== "system")).toEqual([]);
    expect(table.transcript(teamId).some((line) => line.kind === "seat")).toBe(true);
    expect(next.seats.every((seat) => !seat.continuing)).toBe(true);
  });

  it("are listed right after their team, oldest first", () => {
    const { table, teamId, projectFolder } = setup();
    const { teamId: other } = table.create({
      displayName: "另一队",
      projectFolder,
      seats: [{ displayName: "丙", role: "通用", backend: "claude-code", systemPrompt: "简明。" }],
    });
    const { teamId: second } = table.openSession(teamId);
    expect(table.list().teams.map((team) => team.teamId)).toEqual([teamId, second, other]);
    // A team moves with its sessions.
    table.move(other, -1);
    expect(table.list().teams.map((team) => team.teamId)).toEqual([other, teamId, second]);
  });

  it("share every roster, name and material change, whichever session it is made in", () => {
    const { table, teamId } = setup();
    const { teamId: second } = table.openSession(teamId);
    table.addSeat(second, { teamId: second, displayName: "丙", role: "安全" });
    table.rename(second, "评审组二期");
    table.addMaterial(teamId, { name: "需求.md", text: "要做的事" });
    for (const id of [teamId, second]) {
      const team = summaryOf(table, id);
      expect(team.displayName).toBe("评审组二期");
      expect(team.seats.map((seat) => seat.displayName)).toEqual(["甲", "乙", "丙"]);
      expect(team.materials.map((material) => material.name)).toEqual(["需求.md"]);
    }
  });

  it("keep sharing after a restart, read from disk", () => {
    const { table, teamId, store } = setup();
    const { teamId: second } = table.openSession(teamId, "复盘");
    table.rename(teamId, "改过的名字");
    const again = build(store, fakeSeats().seats);
    expect(summaryOf(again, second)).toMatchObject({
      displayName: "改过的名字",
      groupId: teamId,
      sessionLabel: "复盘",
    });
  });

  it("refuse a roster change while another session of the team is mid-round", async () => {
    const { table, teamId, hold, release } = setup();
    const { teamId: second } = table.openSession(teamId);
    hold();
    table.say(teamId, "慢慢想");
    expect(() => table.addSeat(second, { teamId: second, displayName: "丙", role: "安全" })).toThrow(/另一场会话/);
    release();
    await idle(table, teamId);
    table.addSeat(second, { teamId: second, displayName: "丙", role: "安全" });
    expect(summaryOf(table, teamId).seats).toHaveLength(3);
  });

  it("close one at a time, but never the last; disbanding takes them all", () => {
    const { table, teamId } = setup();
    const { teamId: second } = table.openSession(teamId);
    table.closeSession(teamId);
    expect(table.list().teams.map((team) => team.teamId)).toEqual([second]);
    expect(() => table.closeSession(second)).toThrow(/唯一的一场会话/);

    const { teamId: third } = table.openSession(second);
    table.disband(third);
    expect(table.list().teams).toEqual([]);
  });

  it("can be named, and a blank name goes back to the number", () => {
    const { table, teamId } = setup();
    const { teamId: second } = table.openSession(teamId);
    table.renameSession(second, "  上线前复查 ");
    expect(summaryOf(table, second).sessionLabel).toBe("上线前复查");
    table.renameSession(second, "");
    expect(summaryOf(table, second).sessionLabel).toMatch(/^第 2 场 · /);
  });
});

describe("the archive", () => {
  it("lists an archived session under its team, and restores it with what the team holds now", async () => {
    const { table, teamId } = setup();
    const { teamId: second } = table.openSession(teamId);
    table.say(second, "第二场的话");
    await idle(table, second);
    table.closeSession(second);
    table.rename(teamId, "改名之后");

    const view = table.archive();
    expect(view.teams).toEqual([]);
    expect(view.sessions).toMatchObject([{ teamId: second, groupId: teamId, teamName: "改名之后" }]);
    expect(view.sessions[0]?.label).toMatch(/^第 2 场 · /);

    table.restore(second);
    expect(table.archive().sessions).toEqual([]);
    expect(summaryOf(table, second)).toMatchObject({ displayName: "改名之后", groupId: teamId, sessionCount: 2 });
    // Its words came back with it.
    expect(table.transcript(second).some((line) => line.kind === "seat")).toBe(true);
  });

  it("keeps session numbers when one is archived", () => {
    const { table, teamId } = setup();
    const { teamId: second } = table.openSession(teamId);
    const { teamId: third } = table.openSession(teamId);
    table.closeSession(second);
    expect(summaryOf(table, third).sessionLabel).toMatch(/^第 3 场 · /);
  });

  it("brings a whole team back with the sessions archived with it, not one put away before", () => {
    const { table, teamId } = setup();
    const { teamId: second } = table.openSession(teamId);
    const { teamId: third } = table.openSession(teamId);
    table.closeSession(third);
    table.disband(teamId);
    expect(table.list().teams).toEqual([]);
    const view = table.archive();
    expect(view.teams).toHaveLength(1);
    expect(view.teams[0]?.sessions.map((one) => one.teamId)).toEqual([teamId, second, third]);

    table.restore(teamId);
    expect(table.list().teams.map((team) => team.teamId)).toEqual([teamId, second]);
    expect(table.archive().sessions.map((one) => one.teamId)).toEqual([third]);
  });

  it("survives a restart", () => {
    const { table, teamId, store } = setup();
    table.disband(teamId);
    const again = build(store, fakeSeats().seats);
    expect(again.archive().teams.map((team) => team.teamId)).toEqual([teamId]);
    again.restore(teamId);
    expect(again.list().teams.map((team) => team.teamId)).toEqual([teamId]);
  });

  it("deletes for good only what is archived: a session alone, or a team whole", () => {
    const { table, teamId, store, dataDir } = setup();
    const { teamId: second } = table.openSession(teamId);
    expect(() => table.remove(second)).toThrow(/先归档/);

    table.closeSession(second);
    table.remove(second);
    expect(store.loadTeam(second)).toBeUndefined();
    expect(existsSync(join(dataDir, "teams", second))).toBe(false);
    expect(store.loadTeam(teamId)).toBeDefined();
    expect(table.archive().sessions).toEqual([]);

    const { teamId: third } = table.openSession(teamId);
    table.disband(teamId);
    table.remove(teamId);
    for (const id of [teamId, third]) expect(existsSync(join(dataDir, "teams", id))).toBe(false);
    expect(table.archive()).toEqual({ teams: [], sessions: [] });
    expect(() => table.restore(teamId)).toThrow(/归档里没有/);
  });
});

describe("2.x sittings imported before sessions existed", () => {
  it("rejoin their team on start, once, taking the team's roster and name", () => {
    const { table, teamId, store } = setup();
    const base = store.loadTeam<TeamRecord>(teamId);
    if (base === undefined) throw new Error("no base");
    // As 3 imported a sitting before: a team of its own, named for its start.
    store.saveTeam("sit-1", {
      ...base,
      teamId: "sit-1",
      displayName: "评审组 · 10-20 10:30 那一场",
      seats: base.seats.slice(0, 1),
      createdAt: base.createdAt + 1000,
      audit: [
        { at: 1, kind: "imported", detail: `从 Squad 2.x 导入（${teamId} 的一场 sit-1）：3 条发言、0 个检查点。` },
      ],
    } satisfies TeamRecord);
    void table;

    const again = build(store, fakeSeats().seats);
    const sitting = summaryOf(again, "sit-1");
    expect(sitting).toMatchObject({ groupId: teamId, displayName: "评审组", sessionCount: 2 });
    expect(sitting.seats).toHaveLength(2);
    expect(sitting.audit.at(-1)?.detail).toMatch(/归回团队「评审组」/);
    // Once: read again, nothing more is recorded.
    const third = build(store, fakeSeats().seats);
    expect(summaryOf(third, "sit-1").audit.filter((entry) => /归回/.test(entry.detail))).toHaveLength(1);
  });

  it("are read from the import's own audit line, and nothing else", () => {
    expect(
      legacySittingBase({
        audit: [{ kind: "imported", detail: "从 Squad 2.x 导入（team-a 的一场 sit-a）：1 条发言" }],
      }),
    ).toBe("team-a");
    expect(
      legacySittingBase({ audit: [{ kind: "imported", detail: "从 Squad 2.x 导入（团队 team-a）：1 条发言" }] }),
    ).toBeUndefined();
    expect(
      legacySittingBase({
        baseTeamId: "team-a",
        audit: [{ kind: "imported", detail: "从 Squad 2.x 导入（team-a 的一场 sit-a）：1 条发言" }],
      }),
    ).toBeUndefined();
  });
});

describe("session labels", () => {
  it("number sessions by when they started", () => {
    const sessions = [
      { teamId: "b", createdAt: 2 },
      { teamId: "a", createdAt: 1 },
    ];
    expect(sessionLabel({ teamId: "b", createdAt: 2 }, sessions)).toMatch(/^第 2 场 · /);
    expect(sessionLabel({ teamId: "a", createdAt: 1, sessionName: "开场" }, sessions)).toBe("开场");
  });
});
