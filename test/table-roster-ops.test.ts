/**
 * The roster from the library: teams built from agents, connections looked
 * up at each turn, caps checked before a seat starts, and edits that keep
 * speaking order.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/main/context/index.ts";
import { resetSeatSessions, type SeatResult } from "../src/main/seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest, Seats } from "../src/main/seats/index.ts";
import { createSecretary } from "../src/main/secretary/index.ts";
import { createStore, type Store } from "../src/main/store/index.ts";
import { createTable, type Table, type TableLibrary } from "../src/main/table/index.ts";
import type { AgentTemplate, SeatConnection } from "../src/shared/index.ts";

afterEach(() => resetSeatSessions());

function fakeSeats(): { seats: Seats; requests: SeatRequest[] } {
  const requests: SeatRequest[] = [];
  const adapter: SeatAdapter = {
    backend: "claude-code",
    capabilities: { persona: true, resume: true },
    start: (request) => {
      requests.push(request);
      const result: Promise<SeatResult> = Promise.resolve({
        text: "好",
        failed: false,
        cancelled: false,
        exitCode: 0,
        durationMs: 1,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      });
      return { result, cancel: () => undefined };
    },
  };
  return { seats: { adapterFor: () => adapter }, requests };
}

const agent = (over: Partial<AgentTemplate> = {}): AgentTemplate => ({
  templateId: "a1",
  displayName: "架构",
  role: "架构师",
  systemPrompt: "你负责结构。",
  backend: "claude-code",
  secretaryCandidate: true,
  color: "#534AB7",
  enabled: true,
  ...over,
});

const gateway: SeatConnection = {
  connectionId: "gw",
  displayName: "网关",
  authMode: "api-key",
  backend: "claude-code",
  modelId: "MiniMax-H3",
  credentialRef: "GW_KEY",
};

function fakeLibrary() {
  const agents = new Map<string, AgentTemplate>();
  const connections = new Map<string, SeatConnection>();
  const keys = new Map<string, string>();
  let host: string | undefined;
  const port: TableLibrary = {
    template: (id) => agents.get(id),
    hasConnection: (id) => connections.get(id),
    resolveConnection: (id) => {
      const connection = connections.get(id);
      if (connection === undefined) throw new Error(`席位用的连接「${id}」已经不在了。`);
      return { connection, env: { ANTHROPIC_API_KEY: keys.get(id) ?? "" } };
    },
    hostDisplayName: () => host,
  };
  return { port, agents, connections, keys, setHost: (name: string) => (host = name) };
}

function build(store: Store, seats: Seats, library: TableLibrary): Table {
  const late: { table?: Table } = {};
  const context = createContext({
    store,
    secretary: createSecretary(seats),
    facts: (teamId) => (late.table as Table).facts(teamId),
    onFolded: (teamId) => (late.table as Table).folded(teamId),
    onChanged: () => undefined,
  });
  late.table = createTable({ store, seats, context, onChanged: () => undefined, library });
  return late.table;
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-data-"));
  const projectFolder = mkdtempSync(join(tmpdir(), "squad-project-"));
  const store = createStore(dataDir);
  const { seats, requests } = fakeSeats();
  const library = fakeLibrary();
  const table = build(store, seats, library.port);
  return { dataDir, projectFolder, store, seats, table, requests, library };
}

async function idle(table: Table, teamId: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const team = table.list().teams.find((candidate) => candidate.teamId === teamId);
    if (
      team !== undefined &&
      !team.busy &&
      team.commands.every((command) => command.state !== "queued" && command.state !== "running")
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("团队一直没有安静下来。");
}

const teamOf = (table: Table, teamId: string) => {
  const team = table.list().teams.find((candidate) => candidate.teamId === teamId);
  if (team === undefined) throw new Error("no team");
  return team;
};
const names = (table: Table, teamId: string) => teamOf(table, teamId).seats.map((seat) => seat.displayName);

describe("a team built from the library", () => {
  it("copies each agent into a seat, with the host's own name", () => {
    const { table, projectFolder, library } = setup();
    library.agents.set("a1", agent({ permissionMode: "plan", reasoningEffort: "high" }));
    library.agents.set("a2", agent({ templateId: "a2", displayName: "测试", secretaryCandidate: false }));
    library.setHost("阿明");
    const { teamId } = table.create({
      displayName: "组",
      projectFolder,
      members: [{ templateId: "a1", isSecretary: true }, { templateId: "a2" }],
    });
    const team = teamOf(table, teamId);
    expect(team.hostDisplayName).toBe("阿明");
    expect(team.seats.map((seat) => [seat.displayName, seat.isSecretary, seat.templateId])).toEqual([
      ["架构", true, "a1"],
      ["测试", false, "a2"],
    ]);
    expect(team.seats[0]).toMatchObject({ permissionMode: "plan", reasoningEffort: "high", color: "#534AB7" });
  });

  it("refuses a secretary the library says may not be one", () => {
    const { table, projectFolder, library } = setup();
    library.agents.set("a2", agent({ templateId: "a2", displayName: "测试", secretaryCandidate: false }));
    expect(() =>
      table.create({ displayName: "组", projectFolder, members: [{ templateId: "a2", isSecretary: true }] }),
    ).toThrow(/可以当秘书/);
  });

  it("refuses an agent whose connection is gone, at creation rather than at the first round", () => {
    const { table, projectFolder, library } = setup();
    library.agents.set("a1", agent({ connectionId: "gw" }));
    expect(() => table.create({ displayName: "组", projectFolder, members: [{ templateId: "a1" }] })).toThrow(
      /没有这个连接/,
    );
  });
});

describe("the connection, looked up at each turn", () => {
  it("reaches the adapter, and a rotated key reaches the next turn", async () => {
    const { table, projectFolder, library, requests } = setup();
    library.connections.set("gw", gateway);
    library.keys.set("gw", "sk-1");
    library.agents.set("a1", agent({ connectionId: "gw" }));
    const { teamId } = table.create({ displayName: "组", projectFolder, members: [{ templateId: "a1" }] });
    table.say(teamId, "第一轮");
    await idle(table, teamId);
    library.keys.set("gw", "sk-2");
    table.say(teamId, "第二轮");
    await idle(table, teamId);
    const turns = requests.filter((request) => !request.prompt.includes("上下文检查点"));
    expect(turns.map((request) => request.connection?.env["ANTHROPIC_API_KEY"])).toEqual(["sk-1", "sk-2"]);
    expect(turns[0]?.connection?.connection.modelId).toBe("MiniMax-H3");
  });

  it("a connection deleted under a seat fails the turn saying so, never falls back to the host's login", async () => {
    const { table, projectFolder, library, requests } = setup();
    library.connections.set("gw", gateway);
    library.agents.set("a1", agent({ connectionId: "gw" }));
    const { teamId } = table.create({ displayName: "组", projectFolder, members: [{ templateId: "a1" }] });
    library.connections.delete("gw");
    expect(teamOf(table, teamId).seats[0]?.problem).toMatch(/已经不在了/);
    table.say(teamId, "在吗");
    await idle(table, teamId);
    const reply = table.transcript(teamId).find((line) => line.kind === "seat");
    expect(reply).toMatchObject({ failed: true });
    expect(reply?.text).toMatch(/已经不在了/);
    expect(requests.filter((request) => !request.prompt.includes("上下文检查点"))).toEqual([]);
  });
});

describe("caps", () => {
  it("a seat at its turn limit is not started, and the record says why", async () => {
    const { table, projectFolder, library, requests } = setup();
    library.agents.set("a1", agent({ caps: { maxTurns: 1 } }));
    const { teamId } = table.create({ displayName: "组", projectFolder, members: [{ templateId: "a1" }] });
    table.say(teamId, "第一轮");
    await idle(table, teamId);
    table.say(teamId, "第二轮");
    await idle(table, teamId);
    const seatTurns = requests.filter((request) => !request.prompt.includes("上下文检查点"));
    expect(seatTurns).toHaveLength(1);
    const last = table
      .transcript(teamId)
      .filter((line) => line.kind === "seat")
      .at(-1);
    expect(last).toMatchObject({ failed: true });
    expect(last?.text).toMatch(/轮数上限/);
  });

  it("a cost ceiling does not bind a seat on the host's own login", async () => {
    const { table, projectFolder, library, requests } = setup();
    library.agents.set("a1", agent({ caps: { maxCostUsd: 0.000001 } }));
    const { teamId } = table.create({ displayName: "组", projectFolder, members: [{ templateId: "a1" }] });
    table.say(teamId, "一");
    await idle(table, teamId);
    table.say(teamId, "二");
    await idle(table, teamId);
    expect(requests.filter((request) => !request.prompt.includes("上下文检查点"))).toHaveLength(2);
  });
});

describe("editing the roster", () => {
  function team() {
    const fixture = setup();
    fixture.library.agents.set("a1", agent());
    fixture.library.agents.set("a2", agent({ templateId: "a2", displayName: "测试" }));
    fixture.library.agents.set("a3", agent({ templateId: "a3", displayName: "运维" }));
    fixture.library.connections.set("gw", gateway);
    const { teamId } = fixture.table.create({
      displayName: "组",
      projectFolder: fixture.projectFolder,
      members: [{ templateId: "a1", isSecretary: true }, { templateId: "a2" }],
    });
    return { ...fixture, teamId };
  }

  it("adds from the library at the end, and refuses a duplicate name", () => {
    const { table, teamId } = team();
    table.addSeat(teamId, { teamId, templateId: "a3" });
    expect(names(table, teamId)).toEqual(["架构", "测试", "运维"]);
    expect(() => table.addSeat(teamId, { teamId, templateId: "a3" })).toThrow(/都叫「运维」/);
  });

  it("guards the secretary behind a confirmation", () => {
    const { table, teamId } = team();
    const secretary = teamOf(table, teamId).seats[0]?.seatId ?? "";
    expect(() => table.removeSeat(teamId, secretary)).toThrow(/是这支团队的秘书/);
    table.removeSeat(teamId, secretary, { confirmSecretary: true });
    expect(names(table, teamId)).toEqual(["测试"]);
  });

  it("changing a connection keeps the seat where it sits", () => {
    const { table, teamId } = team();
    const first = teamOf(table, teamId).seats[0]?.seatId ?? "";
    table.patchSeat(teamId, first, { connectionId: "gw", caps: { maxTurns: 5 } });
    const seats = teamOf(table, teamId).seats;
    expect(seats.map((seat) => seat.displayName)).toEqual(["架构", "测试"]);
    expect(seats[0]).toMatchObject({ connectionId: "gw", connectionName: "网关", caps: { maxTurns: 5 } });
    table.patchSeat(teamId, first, { connectionId: "" });
    expect(teamOf(table, teamId).seats[0]?.connectionId).toBeUndefined();
    expect(() => table.patchSeat(teamId, first, { connectionId: "nope" })).toThrow(/没有这个连接/);
  });

  it("refuses a connection of another backend", () => {
    const { table, teamId, library } = team();
    library.connections.set("cx", { ...gateway, connectionId: "cx", backend: "codex", displayName: "codex 网关" });
    const first = teamOf(table, teamId).seats[0]?.seatId ?? "";
    expect(() => table.patchSeat(teamId, first, { connectionId: "cx" })).toThrow(/配不到/);
  });

  it("relinks by id, taking the agent's settings and keeping the seat's place and secretary role", () => {
    const { table, teamId } = team();
    const first = teamOf(table, teamId).seats[0]?.seatId ?? "";
    table.relinkSeat(teamId, first, "a3");
    expect(teamOf(table, teamId).seats.map((seat) => [seat.displayName, seat.isSecretary])).toEqual([
      ["运维", true],
      ["测试", false],
    ]);
  });

  it("an edited agent reaches the teams sitting it", () => {
    const { table, teamId } = team();
    const refused = table.syncTemplate(agent({ templateId: "a2", displayName: "测试二号", role: "QA" }));
    expect(refused).toEqual([]);
    expect(names(table, teamId)).toEqual(["架构", "测试二号"]);
  });

  it("an edited agent waits for a team mid-round, and says so", async () => {
    const { table, teamId } = team();
    table.say(teamId, "@测试 慢慢来");
    const refused = table.syncTemplate(agent({ templateId: "a2", displayName: "测试二号" }));
    expect(refused[0]).toMatch(/还在跑/);
    await idle(table, teamId);
  });
});

describe("shared prompts", () => {
  it("a team block reaches every seat, a set's block only its seats, and a leaving seat leaves its sets", async () => {
    const { table, projectFolder, requests } = setup();
    const seat = (name: string) => ({
      displayName: name,
      role: "r",
      systemPrompt: "p",
      backend: "claude-code" as const,
    });
    const { teamId } = table.create({ displayName: "组", projectFolder, seats: [seat("甲"), seat("乙")] });
    const [a, b] = teamOf(table, teamId).seats.map((one) => one.seatId);
    table.setPrompts(teamId, {
      blocks: [
        { blockId: "all", name: "全员规矩", text: "先查再说。" },
        { blockId: "only", name: "产出自查", text: "交付前自查五条。" },
      ],
      teamBlockIds: ["all"],
      sets: [{ setId: "s1", name: "产出型", blockIds: ["only"], seatIds: [b ?? ""] }],
    });
    table.say(teamId, "开始");
    await idle(table, teamId);
    const promptOf = (seatId: string | undefined) =>
      requests.find((request) => request.seat.seatId === seatId && !request.prompt.includes("上下文检查点"))?.prompt ??
      "";
    expect(promptOf(a)).toContain("## 全员规矩");
    expect(promptOf(a)).not.toContain("产出自查");
    expect(promptOf(b)).toContain("## 产出自查");
    expect(() =>
      table.setPrompts(teamId, {
        blocks: [],
        teamBlockIds: [],
        sets: [{ setId: "x", name: "x", blockIds: ["nope"], seatIds: [] }],
      }),
    ).toThrow(/没有「nope」/);
    table.removeSeat(teamId, b ?? "");
    expect(teamOf(table, teamId).prompts.sets[0]?.seatIds).toEqual([]);
  });
});

describe("materials", () => {
  it("an attached document reaches every seat of that command only; a pinned one rides along every time", async () => {
    const { table, projectFolder, requests } = setup();
    const seat = { displayName: "甲", role: "r", systemPrompt: "p", backend: "claude-code" as const };
    const { teamId } = table.create({ displayName: "组", projectFolder, seats: [seat] });
    const spec = table.addMaterial(teamId, { name: "规格.md", text: "接口必须幂等。" }).materialId;
    const style = table.addMaterial(teamId, { name: "风格.md", text: "回答要短。" }).materialId;
    table.setMaterialPinned(teamId, style, true);
    expect(() => table.addMaterial(teamId, { name: "规格.md", text: "接口必须幂等。" })).toThrow(/已经导入过了/);

    table.say(teamId, "按规格评审", [], [spec]);
    await idle(table, teamId);
    table.say(teamId, "再说一句");
    await idle(table, teamId);
    const turns = requests.filter((request) => !request.prompt.includes("上下文检查点"));
    expect(turns[0]?.prompt).toContain("### 规格.md");
    expect(turns[0]?.prompt).toContain("### 风格.md");
    expect(turns[1]?.prompt).not.toContain("### 规格.md");
    expect(turns[1]?.prompt).toContain("### 风格.md");
    // The record says what each command carried.
    const hostLines = table.transcript(teamId).filter((line) => line.kind === "host");
    expect(hostLines[0]?.text).toContain("（本轮附带资料：规格.md、风格.md）");

    table.removeMaterial(teamId, spec);
    expect(() => table.say(teamId, "再看", [], [spec])).toThrow(/移掉/);
    expect(teamOf(table, teamId).materials.map((one) => [one.name, one.pinned])).toEqual([["风格.md", true]]);
  });
});

describe("project memory", () => {
  it("a missing CLAUDE.md: Squad writes a minimal one naming only the folder, the seat gets it, and the record says so", async () => {
    // 2.x 8e96d9c: the seat used to be told to write it, and in an empty folder
    // it went looking for background in the parent and sibling projects.
    const { table, projectFolder, requests } = setup();
    const seat = { displayName: "甲", role: "r", systemPrompt: "p", backend: "claude-code" as const };
    const { teamId } = table.create({ displayName: "组", projectFolder, seats: [seat] });
    table.say(teamId, "开始");
    await idle(table, teamId);
    expect(readFileSync(join(projectFolder, "CLAUDE.md"), "utf8")).toContain("尚未由主持人确认");
    expect(requests[0]?.prompt).toContain("## 这个项目：CLAUDE.md");
    expect(requests[0]?.prompt).not.toContain("## 这个项目还没有 CLAUDE.md");
    const notes = table.transcript(teamId).filter((line) => line.kind === "system" && line.text.includes("CLAUDE.md"));
    expect(notes.map((line) => line.text)).toEqual([expect.stringContaining("最小模板")]);
  });

  it("a present one goes to a fresh conversation, not to a continuing one; dsh gets nothing", async () => {
    const { table, projectFolder, requests } = setup();
    writeFileSync(join(projectFolder, "CLAUDE.md"), "这是登山应用。\n");
    const seat = { displayName: "甲", role: "r", systemPrompt: "p", backend: "claude-code" as const };
    const { teamId } = table.create({ displayName: "组", projectFolder, seats: [seat] });
    table.say(teamId, "一");
    await idle(table, teamId);
    expect(requests[0]?.prompt).toContain("## 这个项目：CLAUDE.md");
    expect(requests[0]?.prompt).toContain("这是登山应用。");
  });
});

describe("audit and export", () => {
  it("decisions go in the audit; each finished command refreshes the readable copy in the project", async () => {
    const { table, projectFolder } = setup();
    writeFileSync(join(projectFolder, "CLAUDE.md"), "x\n");
    const seat = { displayName: "甲", role: "r", systemPrompt: "p", backend: "claude-code" as const };
    const { teamId } = table.create({ displayName: "组", projectFolder, seats: [seat] });
    table.rename(teamId, "新组");
    const id = table.addMaterial(teamId, { name: "a.md", text: "内容" }).materialId;
    table.removeMaterial(teamId, id);
    table.setCoefficient(teamId, 0.3);
    expect(teamOf(table, teamId).audit.map((entry) => entry.kind)).toEqual([
      "team-created",
      "team-renamed",
      "material-added",
      "material-removed",
      "team-renamed",
    ]);
    expect(table.facts(teamId).checkpointCoefficient).toBe(0.3);

    table.say(teamId, "说一句");
    await idle(table, teamId);
    const copy = join(projectFolder, ".squad", "discussions", `${teamId}.md`);
    for (let i = 0; i < 100 && !existsSync(copy); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const text = readFileSync(copy, "utf8");
    expect(text).toContain("# 新组 · 讨论记录");
    expect(text).toContain("说一句");
    expect(text).toContain("## 甲");
  });
});

describe("the team list", () => {
  it("renames, reorders, and a disbanded team stays gone after a restart", () => {
    const { table, projectFolder, store, seats, library } = setup();
    const seat = { displayName: "甲", role: "r", systemPrompt: "p", backend: "claude-code" as const };
    const a = table.create({ displayName: "A", projectFolder, seats: [seat] }).teamId;
    const b = table.create({ displayName: "B", projectFolder, seats: [seat] }).teamId;
    table.rename(a, "甲组");
    table.move(b, -1);
    expect(table.list().teams.map((team) => team.displayName)).toEqual(["B", "甲组"]);
    table.disband(b);
    expect(table.list().teams.map((team) => team.displayName)).toEqual(["甲组"]);
    const again = build(store, seats, library.port);
    expect(again.list().teams.map((team) => team.displayName)).toEqual(["甲组"]);
  });
});
