/**
 * What the table tells the outside world when a round ends, and what it does
 * when a seat goes quiet with a command still open.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/main/context/index.ts";
import { resetSeatSessions, type SeatActivity, type SeatResult } from "../src/main/seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest, Seats } from "../src/main/seats/index.ts";
import { CHECKPOINT_HEADING_LIST, createSecretary } from "../src/main/secretary/index.ts";
import { createStore } from "../src/main/store/index.ts";
import {
  createTable,
  type QuietAskEvent,
  type RoundEndedEvent,
  type Table,
  type TableDeps,
} from "../src/main/table/index.ts";
import type { AgendaSpec } from "../src/shared/index.ts";

afterEach(() => resetSeatSessions());

const WHOLE_CHECKPOINT = CHECKPOINT_HEADING_LIST.map((heading) => `${heading}\n要点`).join("\n\n");

type Answer = (request: SeatRequest) => Promise<Partial<SeatResult>> | Partial<SeatResult>;

function setup(answer: Answer, extra: Partial<TableDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-data-"));
  const projectFolder = mkdtempSync(join(tmpdir(), "squad-project-"));
  writeFileSync(join(projectFolder, "CLAUDE.md"), "测试项目。\n");
  const store = createStore(dataDir);
  const adapter: SeatAdapter = {
    backend: "claude-code",
    capabilities: { persona: true, resume: false },
    start: (request) => {
      const result = (async (): Promise<SeatResult> => {
        if (request.prompt.includes("上下文检查点")) {
          return { text: WHOLE_CHECKPOINT, failed: false, cancelled: false, exitCode: 0, durationMs: 1 };
        }
        return { text: "", failed: false, cancelled: false, exitCode: 0, durationMs: 1, ...(await answer(request)) };
      })();
      return { result, cancel: () => undefined };
    },
  };
  const seats: Seats = { adapterFor: () => adapter };
  const ended: RoundEndedEvent[] = [];
  const asked: QuietAskEvent[] = [];
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
    onRoundEnded: (event) => ended.push(event),
    onQuietAsk: (event) => asked.push(event),
    runCheck: async () => ({ exitCode: 0, tail: "ok", at: Date.now() }),
    ...extra,
  });
  late.table = table;
  const seat = (name: string, isSecretary = false) => ({
    displayName: name,
    role: "工程师",
    systemPrompt: `我是${name}。`,
    backend: "claude-code" as const,
    ...(isSecretary ? { isSecretary: true } : {}),
  });
  const { teamId } = table.create({ displayName: "组", projectFolder, seats: [seat("甲", true), seat("乙")] });
  return { table, teamId, ended, asked };
}

const teamOf = (table: Table, teamId: string) => table.list().teams.find((team) => team.teamId === teamId)!;

async function idle(table: Table, teamId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const team = teamOf(table, teamId);
    if (!team.busy && team.agenda.running === undefined && team.agenda.waiting !== true) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("一直没有停下来。");
}

describe("round ended", () => {
  it("one event per finished command, naming the team and the last good answer", async () => {
    const { table, teamId, ended } = setup((request) =>
      request.seat.displayName === "乙" ? { text: "", failed: true } : { text: "方案 B 更稳。" },
    );
    table.say(teamId, "大家说说");
    await idle(table, teamId);
    expect(ended).toEqual([
      expect.objectContaining({
        teamName: "组",
        kind: "round",
        stopped: false,
        answered: 2,
        failed: 1,
        last: { speaker: "甲", text: "方案 B 更稳。" },
        moreQueued: false,
        waitingForHost: false,
      }),
    ]);
  });

  it("an agenda reports once, when its run ends — not once per step — and says when it waits for the host", async () => {
    const { table, teamId, ended } = setup(() => ({ text: "做完了\n【结果】完成" }));
    const agenda: AgendaSpec = {
      phases: [
        {
          title: "一",
          contextMode: "cumulative",
          exit: "wait-for-host",
          tasks: [{ seatId: "seat-1", instruction: "做一" }],
        },
        { title: "二", contextMode: "cumulative", tasks: [{ seatId: "seat-2", instruction: "做二" }] },
      ],
    };
    const { agendaId, revision } = table.setDraft(teamId, agenda);
    table.resolveAgenda(teamId, { kind: "confirm", agendaId, revision });
    await idle(table, teamId);
    expect(ended).toEqual([expect.objectContaining({ kind: "agenda", waitingForHost: true, answered: 1 })]);
    table.resumeAgenda(teamId);
    await idle(table, teamId);
    expect(ended.at(-1)).toMatchObject({ kind: "agenda", waitingForHost: false, stopped: false, answered: 1 });
    expect(ended).toHaveLength(2);
  });
});

describe("a quiet command", () => {
  /** A seat whose stream reports one silence window with a command still open, then answers. */
  const quietly =
    (seatName: string): Answer =>
    async (request) => {
      if (request.seat.displayName === seatName) {
        const activity: SeatActivity = {
          received: 10,
          open: [{ id: "c1", tool: "Bash", command: "npm test", startedAt: Date.now() - 600_000, background: false }],
          quietForMs: 600_000,
        };
        request.onActivity?.(activity);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return { text: "好了" };
    };

  it("goes to the secretary; a 「wait」 is recorded and nobody is interrupted", async () => {
    const judged: string[] = [];
    const { table, teamId, asked } = setup(quietly("乙"), {
      judgeQuiet: async (_teamId, input) => {
        judged.push(`${input.seat}:${input.commands[0]?.command}`);
        return { verdict: "wait", reason: "测试本来就慢" };
      },
    });
    table.say(teamId, "@乙 跑测试");
    await idle(table, teamId);
    expect(judged).toEqual(["乙:npm test"]);
    expect(asked).toEqual([]);
    const note = table.transcript(teamId).find((line) => line.kind === "system" && line.text.includes("安静了"));
    expect(note?.text).toMatch(/秘书判断：继续等——测试本来就慢/);
    expect(teamOf(table, teamId).audit.some((entry) => entry.kind === "seat-quiet")).toBe(true);
  });

  it("the secretary's own quiet command, or a failed judgement, goes straight to the host — with the reason", async () => {
    const own = setup(quietly("甲"), { judgeQuiet: async () => ({ verdict: "wait", reason: "不该被问到" }) });
    own.table.say(own.teamId, "@甲 跑测试");
    await idle(own.table, own.teamId);
    expect(own.asked).toEqual([
      expect.objectContaining({ seat: "甲", reason: "安静的正是秘书自己，所以直接请你看。" }),
    ]);

    const failing = setup(quietly("乙"), {
      judgeQuiet: async () => {
        throw new Error("秘书掉线了");
      },
    });
    failing.table.say(failing.teamId, "@乙 跑测试");
    await idle(failing.table, failing.teamId);
    expect(failing.asked[0]?.reason).toMatch(/秘书没能给出判断（秘书掉线了）/);
  });
});
