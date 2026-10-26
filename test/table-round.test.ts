/**
 * Commands through the table, the context layer and the secretary together,
 * with fake seats so no CLI is needed.
 *
 * What these hold: who is asked, in what order, what each seat is shown, what
 * reaches the record — and that folding, stopping and resuming each leave the
 * record saying what actually happened.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/main/context/index.ts";
import { resetSeatSessions, type SeatResult } from "../src/main/seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest, Seats } from "../src/main/seats/index.ts";
import { CHECKPOINT_HEADING_LIST, createSecretary } from "../src/main/secretary/index.ts";
import { createStore, type Store } from "../src/main/store/index.ts";
import { createTable, type Table } from "../src/main/table/index.ts";
import type { SeatInput } from "../src/shared/wire.ts";

afterEach(() => resetSeatSessions());

type Answer = (request: SeatRequest) => Promise<Partial<SeatResult>> | Partial<SeatResult>;

const WHOLE_CHECKPOINT = CHECKPOINT_HEADING_LIST.map((heading) => `${heading}\n要点`).join("\n\n");

function fakeSeats(answer: Answer): { seats: Seats; requests: SeatRequest[] } {
  const requests: SeatRequest[] = [];
  const adapter: SeatAdapter = {
    backend: "claude-code",
    capabilities: { persona: true, resume: true },
    start: (request) => {
      requests.push(request);
      const result = (async (): Promise<SeatResult> => {
        // The secretary writing a checkpoint, whatever the test's seats do.
        if (request.prompt.includes("上下文检查点")) {
          return { text: WHOLE_CHECKPOINT, failed: false, cancelled: false, exitCode: 0, durationMs: 1 };
        }
        const partial = await answer(request);
        return {
          text: "",
          failed: false,
          cancelled: false,
          exitCode: 0,
          durationMs: 5,
          usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 10, costUsd: 0.01 },
          ...partial,
        };
      })();
      return { result, cancel: () => undefined };
    },
  };
  return { seats: { adapterFor: () => adapter }, requests };
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

const seat = (displayName: string, extra: Partial<SeatInput> = {}): SeatInput => ({
  displayName,
  role: "工程师",
  systemPrompt: `我是${displayName}。`,
  backend: "claude-code",
  ...extra,
});

function setup(answer: Answer, roster: readonly SeatInput[] = [seat("甲")]) {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-data-"));
  const projectFolder = mkdtempSync(join(tmpdir(), "squad-project-"));
  // A project that already has its notes file: without one, every fresh seat
  // is first asked to write it (see "project memory" below).
  writeFileSync(join(projectFolder, "CLAUDE.md"), "测试项目。\n");
  const store = createStore(dataDir);
  const { seats, requests } = fakeSeats(answer);
  const table = build(store, seats);
  const { teamId } = table.create({ displayName: "测试组", projectFolder, seats: [...roster] });
  return { dataDir, store, seats, table, teamId, requests };
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

const seatLines = (table: Table, teamId: string) =>
  table
    .transcript(teamId)
    .filter((line) => line.kind === "seat")
    .map((line) => [line.speaker, line.text]);

describe("a command", () => {
  it("records the instruction, what the seat was handed, and its answer", async () => {
    const { table, teamId, store } = setup(() => ({ text: "收到" }));
    const { commandId } = table.say(teamId, "只回答两个字：收到");
    await idle(table, teamId);
    expect(
      store
        .logFor(teamId)
        .read()
        .map((event) => event.type),
    ).toEqual(["host/message", "seat/request", "seat/reply"]);
    expect(table.seatRequest(teamId, commandId, "seat-1").prompt).toContain("只回答两个字：收到");
    expect(seatLines(table, teamId)).toEqual([["甲", "收到"]]);
  });

  it("carries the earlier discussion into the next turn of a fresh seat", async () => {
    const { table, teamId, requests } = setup((request) => ({
      text: request.prompt.includes("第二轮") ? "记得" : "TOML",
    }));
    table.say(teamId, "第一轮：选什么格式？");
    await idle(table, teamId);
    table.say(teamId, "第二轮：刚才选了什么？");
    await idle(table, teamId);
    const second = requests[1]?.prompt ?? "";
    expect(second).toContain("【甲】TOML");
    expect(second.indexOf("第二轮：刚才选了什么？")).toBeGreaterThan(second.indexOf("</team-record>"));
  });
});

describe("@ 点名", () => {
  it("只问被点到的人，指令里去掉开头的点名", async () => {
    const { table, teamId, requests } = setup(() => ({ text: "好" }), [seat("甲"), seat("乙")]);
    table.say(teamId, "@乙 你来看看");
    await idle(table, teamId);
    expect(requests.map((request) => request.seat.displayName)).toEqual(["乙"]);
    expect(requests[0]?.prompt.trimEnd().endsWith("你来看看")).toBe(true);
  });

  it("名字打错就拒，不会悄悄发给所有人", () => {
    const { table, teamId } = setup(() => ({ text: "好" }), [seat("甲"), seat("乙")]);
    expect(() => table.say(teamId, "@丙 你来看看")).toThrow(/没有叫「丙」的席位/);
  });
});

describe("parallel seats, ordered commands", () => {
  it("two seats answer at once; one seat takes its commands in the order sent", async () => {
    const releases: (() => void)[] = [];
    const order: string[] = [];
    const { table, teamId } = setup(
      (request) =>
        new Promise((resolve) => {
          order.push(`${request.seat.displayName}:${request.prompt.trimEnd().split("\n").at(-1)}`);
          releases.push(() => resolve({ text: "好" }));
        }),
      [seat("甲"), seat("乙")],
    );
    table.say(teamId, "一号指令");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both seats started on the first command: parallel.
    expect(order).toEqual(["甲:一号指令", "乙:一号指令"]);
    table.say(teamId, "@甲 二号指令");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 甲 is still busy with 一号: 二号 waits for it rather than overtaking.
    expect(order).toHaveLength(2);
    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order.at(-1)).toBe("甲:二号指令");
    for (const release of releases.slice(1)) release();
    await idle(table, teamId);
  });

  it("a seat is not shown, as discussion, the command it is answering or one queued for it", async () => {
    let release: () => void = () => undefined;
    const { table, teamId, requests } = setup(
      (request) =>
        request.prompt.includes("二号")
          ? { text: "答二号" }
          : new Promise((resolve) => (release = () => resolve({ text: "答一号" }))),
      [seat("甲")],
    );
    table.say(teamId, "一号");
    table.say(teamId, "二号");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests[0]?.prompt).not.toContain("<team-record>");
    release();
    await idle(table, teamId);
    const second = requests[1]?.prompt ?? "";
    // 二号 was sent while 甲 was answering 一号, so the reply says which
    // command it answers (2.x's replyTag) — the record would be ambiguous otherwise.
    expect(second).toMatch(/【甲】（答 \d\d:\d\d「一号」）\n答一号/);
    // 二号 is the instruction, after the record — not a line inside it.
    expect(second.split("</team-record>")[0]).not.toContain("【主持人】二号");
  });
});

describe("stopping", () => {
  it("withdrawing a command no seat has started records it as withdrawn", async () => {
    let release: () => void = () => undefined;
    const { table, teamId } = setup(() => new Promise((resolve) => (release = () => resolve({ text: "好" }))));
    table.say(teamId, "一号");
    const { commandId } = table.say(teamId, "二号");
    table.cancel(teamId, commandId);
    // 一号 starts only after the fresh-start check; release it once it has.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await idle(table, teamId);
    const notes = table
      .transcript(teamId)
      .filter((line) => line.kind === "system")
      .map((line) => line.text);
    expect(notes).toEqual(["↩ 主持人撤回了「二号」"]);
    // Tagged: 二号 sits between 一号 and this reply in the record, withdrawn or not.
    expect(seatLines(table, teamId)).toEqual([["甲", expect.stringMatching(/^（答 \d\d:\d\d「一号」）\n好$/)]]);
  });

  it("stopping a running seat records what it had said, marked unfinished", async () => {
    const { table, teamId } = setup(
      (request) =>
        new Promise((resolve) =>
          request.signal?.addEventListener("abort", () =>
            resolve({ text: "我先读两份文档", failed: true, cancelled: true }),
          ),
        ),
    );
    table.say(teamId, "评审一下");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(table.stop(teamId).stopped).toBe(true);
    await idle(table, teamId);
    const reply = table.transcript(teamId).find((line) => line.kind === "seat");
    expect(reply?.text).toBe("我先读两份文档\n\n（被叫停，未答完）");
    expect(reply?.cancelled).toBe(true);
  });

  it("a stopped seat that had said nothing gets a line saying so", async () => {
    const { table, teamId } = setup(
      (request) =>
        new Promise((resolve) =>
          request.signal?.addEventListener("abort", () => resolve({ text: "", failed: true, cancelled: true })),
        ),
    );
    table.say(teamId, "评审一下");
    await new Promise((resolve) => setTimeout(resolve, 20));
    table.stop(teamId);
    await idle(table, teamId);
    const notes = table
      .transcript(teamId)
      .filter((line) => line.kind === "system")
      .map((line) => line.text);
    expect(notes).toContain("⏹ 甲 被叫停，这一轮没有答复。");
  });
});

describe("a restart", () => {
  it("shows a command it cut off as interrupted, and sends it again only when asked", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "squad-data-"));
    const projectFolder = mkdtempSync(join(tmpdir(), "squad-project-"));
    const hanging = fakeSeats(() => new Promise(() => undefined));
    const first = build(createStore(dataDir), hanging.seats);
    const { teamId } = first.create({ displayName: "x", projectFolder, seats: [seat("甲")] });
    const { commandId } = first.say(teamId, "做到一半的事");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const answering = fakeSeats(() => ({ text: "做完了" }));
    const second = build(createStore(dataDir), answering.seats);
    const team = second.list().teams[0];
    expect(team?.commands.map((command) => [command.commandId, command.state])).toEqual([[commandId, "interrupted"]]);
    // Nothing restarted by itself.
    expect(answering.requests).toHaveLength(0);
    second.resend(teamId, commandId);
    await idle(second, teamId);
    expect(answering.requests).toHaveLength(1);
    expect(seatLines(second, teamId)).toEqual([["甲", "做完了"]]);
  });

  it("a command cut off by quitting comes back interrupted, not as a stop nobody made", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "squad-data-"));
    const projectFolder = mkdtempSync(join(tmpdir(), "squad-project-"));
    writeFileSync(join(projectFolder, "CLAUDE.md"), "测试项目。\n");
    const killable = fakeSeats(
      (request) =>
        new Promise((resolve) =>
          request.signal?.addEventListener("abort", () => resolve({ text: "写到一半", failed: true, cancelled: true })),
        ),
    );
    const first = build(createStore(dataDir), killable.seats);
    const { teamId } = first.create({ displayName: "x", projectFolder, seats: [seat("甲")] });
    const { commandId } = first.say(teamId, "写一篇长文");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.stopAll();

    const second = build(createStore(dataDir), fakeSeats(() => ({ text: "好" })).seats);
    expect(second.transcript(teamId).filter((line) => line.kind !== "host")).toEqual([]);
    expect(second.list().teams[0]?.commands.map((command) => [command.commandId, command.state])).toEqual([
      [commandId, "interrupted"],
    ]);
  });

  it("keeps usage across a reload", async () => {
    const { table, teamId, dataDir, seats } = setup(() => ({ text: "好" }));
    table.say(teamId, "一");
    await idle(table, teamId);
    table.say(teamId, "二");
    await idle(table, teamId);
    const reloaded = build(createStore(dataDir), seats);
    const usage = reloaded.list().teams[0]?.usage;
    expect(usage?.turns).toBe(2);
    expect(usage?.costUsd).toBeCloseTo(0.02);
  });
});

describe("continuing a seat's own conversation", () => {
  it("resumes with the id it got, and hands over only what is new", async () => {
    const { table, teamId, requests } = setup((request) => ({
      text: request.resumeId === undefined ? "第一次" : "第二次",
      sessionId: "sess-1",
    }));
    table.say(teamId, "第一问");
    await idle(table, teamId);
    table.say(teamId, "第二问");
    await idle(table, teamId);
    expect(requests[1]?.resumeId).toBe("sess-1");
    // Its conversation already holds 第一问 and its own answer.
    expect(requests[1]?.prompt).not.toContain("第一问");
    expect(table.list().teams[0]?.seats[0]?.continuing).toBe(true);
  });

  it("a conversation the CLI no longer has is dropped and the turn run again, fresh, with the whole window", async () => {
    const { table, teamId, requests } = setup((request) =>
      request.resumeId === "sess-1"
        ? { text: "No conversation found with session ID: sess-1", failed: true }
        : { text: "答", sessionId: request.resumeId === undefined && requests.length > 1 ? "sess-2" : "sess-1" },
    );
    table.say(teamId, "第一问");
    await idle(table, teamId);
    table.say(teamId, "第二问");
    await idle(table, teamId);
    expect(requests.map((request) => request.resumeId)).toEqual([undefined, "sess-1", undefined]);
    expect(requests[2]?.prompt).toContain("【主持人】第一问");
    expect(seatLines(table, teamId)).toEqual([
      ["甲", "答"],
      ["甲", "答"],
    ]);
  });
});

describe("folding", () => {
  it("a manual fold replaces the earlier discussion with the checkpoint, and drops every conversation", async () => {
    const { table, teamId, requests, store } = setup(() => ({ text: "很长的旧回答", sessionId: "sess-1" }));
    table.say(teamId, "旧问题");
    await idle(table, teamId);
    const context = createContext({
      store,
      secretary: createSecretary(fakeSeats(() => ({ text: "" })).seats),
      facts: (id) => table.facts(id),
      onFolded: (id) => table.folded(id),
      onChanged: () => undefined,
    });
    const recorded = await context.fold(teamId);
    expect(recorded.coversUpTo).not.toBe("");
    expect(table.list().teams[0]?.seats[0]?.continuing).toBe(false);

    table.say(teamId, "新问题");
    await idle(table, teamId);
    const after = requests.at(-1)?.prompt ?? "";
    expect(after).toContain("【上下文检查点】");
    expect(after).not.toContain("很长的旧回答");
    expect(requests.at(-1)?.resumeId).toBeUndefined();
    expect(table.transcript(teamId).some((line) => line.kind === "checkpoint")).toBe(true);
  });
});

describe("a seat that throws", () => {
  it("still lands in the record as a failed reply that says why", async () => {
    const { table, teamId } = setup(() => {
      throw new Error("适配器坏了");
    });
    table.say(teamId, "试试");
    await idle(table, teamId);
    const answer = table.transcript(teamId).find((line) => line.kind === "seat");
    expect(answer?.failed).toBe(true);
    expect(answer?.text).toContain("适配器坏了");
  });
});

describe("creating a team", () => {
  const create = (seats: readonly SeatInput[], folder?: string) => {
    const store = createStore(mkdtempSync(join(tmpdir(), "squad-data-")));
    const table = build(store, fakeSeats(() => ({ text: "" })).seats);
    return () =>
      table.create({ displayName: "x", projectFolder: folder ?? mkdtempSync(join(tmpdir(), "p-")), seats: [...seats] });
  };

  it("refuses a folder that does not exist", () => {
    expect(create([seat("甲")], "Z:\\no\\such\\folder")).toThrow(/不存在/);
  });

  it("refuses two seats with one name", () => {
    expect(create([seat("甲"), seat("甲")])).toThrow(/都叫「甲」/);
  });

  it("refuses two secretaries", () => {
    expect(create([seat("甲", { isSecretary: true }), seat("乙", { isSecretary: true })])).toThrow(/只能有一位秘书/);
  });
});
