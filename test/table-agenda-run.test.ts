/**
 * A confirmed agenda through the table: who runs what, what the checks decide,
 * where it stops for a person, and what it leaves when stopped.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContext } from "../src/main/context/index.ts";
import { resetSeatSessions, type SeatResult } from "../src/main/seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest, Seats } from "../src/main/seats/index.ts";
import { CHECKPOINT_HEADING_LIST, createSecretary } from "../src/main/secretary/index.ts";
import { createStore } from "../src/main/store/index.ts";
import { createTable, type AgendaTermination, type Table, type TableDeps } from "../src/main/table/index.ts";
import type { AgendaSpec, ExitCheckResult } from "../src/shared/index.ts";

afterEach(() => resetSeatSessions());

type Answer = (request: SeatRequest) => Promise<Partial<SeatResult>> | Partial<SeatResult>;
const WHOLE_CHECKPOINT = CHECKPOINT_HEADING_LIST.map((heading) => `${heading}\n要点`).join("\n\n");

function fakeSeats(answer: Answer): { seats: Seats; requests: SeatRequest[] } {
  const requests: SeatRequest[] = [];
  const adapter: SeatAdapter = {
    backend: "claude-code",
    capabilities: { persona: true, resume: false },
    start: (request) => {
      requests.push(request);
      const result = (async (): Promise<SeatResult> => {
        if (request.prompt.includes("上下文检查点")) {
          return { text: WHOLE_CHECKPOINT, failed: false, cancelled: false, exitCode: 0, durationMs: 1 };
        }
        return { text: "", failed: false, cancelled: false, exitCode: 0, durationMs: 1, ...(await answer(request)) };
      })();
      return { result, cancel: () => undefined };
    },
  };
  return { seats: { adapterFor: () => adapter }, requests };
}

function setup(
  answer: Answer,
  options: {
    check?: (command: string) => ExitCheckResult;
    onStopped?: TableDeps["onAgendaStopped"];
    proxy?: TableDeps["proxy"];
  } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-data-"));
  const projectFolder = mkdtempSync(join(tmpdir(), "squad-project-"));
  writeFileSync(join(projectFolder, "CLAUDE.md"), "测试项目。\n");
  const store = createStore(dataDir);
  const { seats, requests } = fakeSeats(answer);
  const checks: string[] = [];
  const build = (): Table => {
    const late: { table?: Table } = {};
    const context = createContext({
      store,
      secretary: createSecretary(seats),
      facts: (teamId) => (late.table as Table).facts(teamId),
      onFolded: (teamId) => (late.table as Table).folded(teamId),
      onChanged: () => undefined,
    });
    late.table = createTable({
      store,
      seats,
      context,
      onChanged: () => undefined,
      ...(options.onStopped === undefined ? {} : { onAgendaStopped: options.onStopped }),
      ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
      runCheck: async (check) => {
        checks.push(check.command);
        if (check.command.startsWith("git ")) return { exitCode: 128, tail: "not a repo", at: Date.now() };
        return options.check?.(check.command) ?? { exitCode: 0, tail: "ok", at: Date.now() };
      },
    });
    return late.table;
  };
  const table = build();
  const seat = (name: string) => ({
    displayName: name,
    role: "工程师",
    systemPrompt: `我是${name}。`,
    backend: "claude-code" as const,
  });
  const { teamId } = table.create({ displayName: "组", projectFolder, seats: [seat("甲"), seat("乙")] });
  return { table, teamId, requests, checks, store, build, dataDir, projectFolder };
}

const teamOf = (table: Table, teamId: string) => table.list().teams.find((team) => team.teamId === teamId)!;

async function settledAgenda(table: Table, teamId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const team = teamOf(table, teamId);
    if (team.agenda.running === undefined && !team.busy && team.agenda.waiting !== true) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("议程一直没有停下来。");
}

const twoPhases: AgendaSpec = {
  phases: [
    { title: "设计", contextMode: "cumulative", tasks: [{ seatId: "seat-1", instruction: "写设计" }] },
    {
      title: "实现",
      contextMode: "cumulative",
      tasks: [{ seatId: "seat-2", instruction: "按设计实现" }],
      check: { command: "npm test" },
    },
  ],
};

function confirm(table: Table, teamId: string, agenda: AgendaSpec, extra: { proxy?: boolean } = {}): void {
  const { agendaId, revision } = table.setDraft(teamId, agenda);
  table.resolveAgenda(teamId, { kind: "confirm", agendaId, revision, ...extra });
}

/** The task a turn was asked, without the discussion window that carries earlier lines. */
const taskOf = (request: SeatRequest): string => request.prompt.slice(request.prompt.lastIndexOf("## 本轮指令"));

const seatTurns = (requests: SeatRequest[]) => requests.filter((request) => !request.prompt.includes("上下文检查点"));

describe("drafts", () => {
  it("refuses a draft naming a seat that is not at the table", () => {
    const { table, teamId } = setup(() => ({ text: "【结果】完成" }));
    expect(() =>
      table.setDraft(teamId, {
        phases: [{ title: "x", contextMode: "cumulative", tasks: [{ seatId: "ghost", instruction: "做" }] }],
      }),
    ).toThrow(/不存在的席位「ghost」/);
  });

  it("confirms only the revision the host was looking at, and only a standing draft", () => {
    const { table, teamId } = setup(() => ({ text: "【结果】完成" }));
    expect(() => table.resolveAgenda(teamId, { kind: "confirm", agendaId: "x", revision: 1 })).toThrow(/没有待确认/);
    const first = table.setDraft(teamId, twoPhases);
    table.setDraft(teamId, twoPhases);
    expect(() => table.resolveAgenda(teamId, { kind: "confirm", ...first })).toThrow();
    expect(teamOf(table, teamId).agenda.draft?.revision).toBe(2);
  });

  it("discarding clears the draft and runs nothing", () => {
    const { table, teamId, requests } = setup(() => ({ text: "【结果】完成" }));
    const identity = table.setDraft(teamId, twoPhases);
    table.resolveAgenda(teamId, { kind: "discard", ...identity });
    expect(teamOf(table, teamId).agenda.draft).toBeUndefined();
    expect(requests).toEqual([]);
  });
});

describe("running", () => {
  it("runs each phase's seat with its task and the report footer, checks with Squad, and finishes", async () => {
    const { table, teamId, requests, checks } = setup(() => ({ text: "做好了\n【结果】完成" }));
    confirm(table, teamId, twoPhases);
    await settledAgenda(table, teamId);
    const turns = seatTurns(requests);
    expect(turns.map((request) => request.seat.displayName)).toEqual(["甲", "乙"]);
    expect(turns[1]?.prompt).toContain("按设计实现");
    expect(turns[1]?.prompt).toContain("【结果】完成");
    expect(checks).toContain("npm test");
    const agenda = teamOf(table, teamId).agenda.confirmed;
    expect(agenda?.standing).toBe("finished");
    expect(agenda?.nodes.map((node) => node.state)).toEqual(["passed", "passed"]);
    const lines = table.transcript(teamId);
    expect(lines.filter((line) => line.kind === "host").map((line) => line.text)).toEqual([
      "（设计）写设计",
      "（实现）按设计实现",
    ]);
    expect(lines.some((line) => line.kind === "system" && line.text.includes("出口检查通过"))).toBe(true);
    expect(lines.at(-1)?.text).toMatch(/议程跑完/);
  });

  it("a failing check sends the seat back with the check's output, then stops for a decision", async () => {
    const { table, teamId, requests } = setup(() => ({ text: "改了\n【结果】完成" }), {
      check: () => ({ exitCode: 1, tail: "2 tests failed", at: Date.now() }),
    });
    confirm(table, teamId, twoPhases);
    await settledAgenda(table, teamId);
    const builder = seatTurns(requests).filter((request) => request.seat.displayName === "乙");
    expect(builder).toHaveLength(3);
    expect(builder[1]?.prompt).toContain("2 tests failed");
    const agenda = teamOf(table, teamId).agenda.confirmed;
    expect(agenda?.standing).toBe("deciding");
    expect(agenda?.nodes[1]).toMatchObject({ state: "deciding", attempts: 3 });
    expect(table.transcript(teamId).at(-1)?.text).toMatch(/议程停在「实现」/);
  });

  it("a seat that answers a failed check with 「被卡住」 keeps that check on the node, for the decision to read", async () => {
    // Seen in the walkthrough: the check failed, the seat said it was blocked by
    // the check, and the panel said the check had never run.
    let turn = 0;
    const { table, teamId, checks } = setup(
      (request) =>
        request.seat.displayName === "乙" && ++turn > 1
          ? { text: "【结果】被卡住：检查和任务矛盾" }
          : { text: "【结果】完成" },
      { check: () => ({ exitCode: 1, tail: "expected 2", at: Date.now() }) },
    );
    confirm(table, teamId, twoPhases);
    await settledAgenda(table, teamId);
    expect(checks.filter((command) => command === "npm test")).toHaveLength(1);
    const node = teamOf(table, teamId).agenda.confirmed?.nodes[1];
    expect(node).toMatchObject({ state: "deciding", attempts: 2, lastCheck: { exitCode: 1, tail: "expected 2" } });
  });

  it("「视为通过」 at a decision point finishes it; the audit says who decided what", async () => {
    const { table, teamId } = setup(() => ({ text: "【结果】完成" }), {
      check: () => ({ exitCode: 1, tail: "no", at: Date.now() }),
    });
    confirm(table, teamId, twoPhases);
    await settledAgenda(table, teamId);
    table.decideNode(teamId, "p2", { kind: "pass" });
    await settledAgenda(table, teamId);
    const team = teamOf(table, teamId);
    expect(team.agenda.confirmed?.standing).toBe("finished");
    expect(team.audit.map((entry) => entry.kind)).toContain("agenda-decided");
  });

  it("a seat that says it is blocked stops the phase there; an assigned helper clears it and the phase's own seat carries on", async () => {
    let blocked = true;
    const { table, teamId, requests } = setup((request) => {
      if (request.seat.displayName === "乙" && blocked) return { text: "缺依赖\n【结果】被卡住：甲没装依赖" };
      return { text: "【结果】完成" };
    });
    confirm(table, teamId, twoPhases);
    await settledAgenda(table, teamId);
    expect(teamOf(table, teamId).agenda.confirmed?.nodes[1]?.why).toMatch(/被卡住/);
    blocked = false;
    table.decideNode(teamId, "p2", { kind: "assign", seatId: "seat-1", instruction: "装好依赖" });
    await settledAgenda(table, teamId);
    const after = seatTurns(requests)
      .slice(2)
      .map((request) => request.seat.displayName);
    expect(after).toEqual(["甲", "乙"]);
    expect(seatTurns(requests)[2]?.prompt).toContain("装好依赖");
    expect(teamOf(table, teamId).agenda.confirmed?.standing).toBe("finished");
  });

  it("an independent phase hands every seat the same opening snapshot", async () => {
    const { table, teamId, requests } = setup((request) => ({
      text: `${request.seat.displayName}的意见\n【结果】完成`,
    }));
    confirm(table, teamId, {
      phases: [
        {
          title: "各自评审",
          contextMode: "independent",
          tasks: [
            { seatId: "seat-1", instruction: "评审" },
            { seatId: "seat-2", instruction: "评审" },
          ],
        },
      ],
    });
    await settledAgenda(table, teamId);
    const second = seatTurns(requests)[1]?.prompt ?? "";
    expect(second).not.toContain("甲的意见");
  });

  it("commands sent while an agenda runs wait until it ends", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { table, teamId, requests } = setup(async (request) => {
      if (request.prompt.includes("写设计")) await gate;
      return { text: "【结果】完成" };
    });
    confirm(table, teamId, twoPhases);
    await new Promise((resolve) => setTimeout(resolve, 30));
    table.say(teamId, "@甲 顺便问一句");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seatTurns(requests).some((request) => taskOf(request).includes("顺便问一句"))).toBe(false);
    release();
    await settledAgenda(table, teamId);
    for (let i = 0; i < 100 && !seatTurns(requests).some((r) => taskOf(r).includes("顺便问一句")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const order = seatTurns(requests).map((request) => (taskOf(request).includes("顺便问一句") ? "command" : "agenda"));
    expect(order).toEqual(["agenda", "agenda", "command"]);
  });
});

describe("stopping, pausing, resuming", () => {
  it("a stop keeps the plan, hands over what is left, and 「继续」 re-runs what did not pass", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stopped: AgendaTermination[] = [];
    const { table, teamId, requests } = setup(
      async (request) => {
        if (request.prompt.includes("按设计实现")) await gate;
        return { text: "【结果】完成", ...(request.signal?.aborted ? { cancelled: true, failed: true } : {}) };
      },
      { onStopped: (_teamId, termination) => stopped.push(termination) },
    );
    confirm(table, teamId, twoPhases);
    for (let i = 0; i < 100 && teamOf(table, teamId).agenda.running?.phase !== "实现"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    table.stop(teamId);
    release();
    await settledAgenda(table, teamId);
    expect(stopped[0]?.remaining.join()).toContain("实现");
    expect(stopped[0]?.remaining.join()).not.toContain("阶段「设计」");
    expect(stopped[0]?.completed).toContain("阶段「设计」已通过");
    expect(teamOf(table, teamId).agenda.confirmed?.nodes.map((node) => node.state)).toEqual(["passed", "pending"]);
    table.resumeAgenda(teamId);
    await settledAgenda(table, teamId);
    expect(teamOf(table, teamId).agenda.confirmed?.standing).toBe("finished");
    expect(seatTurns(requests).filter((request) => taskOf(request).includes("写设计"))).toHaveLength(1);
  });

  it("a phase that waits for the host pauses; 「继续」 goes on", async () => {
    const { table, teamId, requests } = setup(() => ({ text: "【结果】完成" }));
    confirm(table, teamId, {
      phases: [
        {
          title: "提案",
          contextMode: "cumulative",
          tasks: [{ seatId: "seat-1", instruction: "提案" }],
          exit: "wait-for-host",
        },
        { title: "执行", contextMode: "cumulative", tasks: [{ seatId: "seat-2", instruction: "执行" }] },
      ],
    });
    await settledAgenda(table, teamId);
    expect(seatTurns(requests)).toHaveLength(1);
    expect(table.transcript(teamId).at(-1)?.text).toMatch(/等主持人/);
    table.resumeAgenda(teamId);
    await settledAgenda(table, teamId);
    expect(seatTurns(requests)).toHaveLength(2);
  });

  it("after a restart an agenda step is not an interrupted command to resend; rewind and abandon change the plan, not the record", async () => {
    const { table, teamId, build } = setup(() => ({ text: "【结果】完成" }));
    confirm(table, teamId, twoPhases);
    await settledAgenda(table, teamId);
    const again = build();
    expect(teamOf(again, teamId).commands.filter((command) => command.state === "interrupted")).toEqual([]);
    expect(teamOf(again, teamId).agenda.confirmed?.standing).toBe("finished");
    again.rewindAgenda(teamId, 1);
    expect(teamOf(again, teamId).agenda.confirmed?.nodes.map((node) => node.state)).toEqual(["passed", "pending"]);
    const lines = again.transcript(teamId).length;
    again.abandonAgenda(teamId);
    expect(teamOf(again, teamId).agenda.confirmed).toBeUndefined();
    expect(again.transcript(teamId).length).toBe(lines + 1);
  });
});

describe("Lil X in the chair", () => {
  it("decides at a failing check instead of stopping, speaks under its own name, and writes the report", async () => {
    let failures = 3;
    const points: string[] = [];
    const { table, teamId, requests, projectFolder } = setup(() => ({ text: "【结果】完成" }), {
      check: () =>
        failures-- > 0
          ? { exitCode: 1, tail: "1 test failed", at: Date.now() }
          : { exitCode: 0, tail: "ok", at: Date.now() },
      proxy: async (point) => {
        points.push(point.why);
        return { kind: "retry", instruction: "先修那个失败的测试再交", say: "按检查的输出修" };
      },
    });
    confirm(table, teamId, twoPhases, { proxy: true });
    await settledAgenda(table, teamId);
    const team = teamOf(table, teamId);
    expect(team.agenda.confirmed?.standing).toBe("finished");
    expect(points).toHaveLength(1);
    const proxyLines = table.transcript(teamId).filter((line) => line.kind === "proxy");
    expect(proxyLines[0]?.speaker).toBe("Lil X（代主持人）");
    expect(team.agenda.confirmed?.decisions.map((one) => one.detail)).toEqual(["重做：先修那个失败的测试再交"]);
    expect(seatTurns(requests).at(-1)?.prompt).toContain("先修那个失败的测试再交");
    expect(team.agenda.confirmed?.reportPath).toMatch(/\.squad/);
    expect(readFileSync(join(projectFolder, team.agenda.confirmed?.reportPath ?? ""), "utf8")).toContain(
      "Lil X 替你做的决定（1）",
    );
  });

  it("after three decisions at one node it puts the node down and carries on with the rest", async () => {
    const { table, teamId } = setup(() => ({ text: "【结果】完成" }), {
      check: () => ({ exitCode: 1, tail: "no", at: Date.now() }),
      proxy: async () => ({ kind: "retry", instruction: "再试", say: "再试" }),
    });
    confirm(table, teamId, twoPhases, { proxy: true });
    await settledAgenda(table, teamId);
    const confirmed = teamOf(table, teamId).agenda.confirmed;
    expect(confirmed?.nodes[1]?.state).toBe("unresolved");
    expect(confirmed?.decisions.at(-1)?.detail).toMatch(/决定次数用完/);
    expect(confirmed?.standing).toBe("ended");
  });

  it("answers a phase that waits for the host, and the next phase reads the answer", async () => {
    const { table, teamId, requests } = setup(() => ({ text: "【结果】完成" }), {
      proxy: async () => ({ kind: "answer", text: "用方案二" }),
    });
    confirm(
      table,
      teamId,
      {
        phases: [
          {
            title: "提案",
            contextMode: "cumulative",
            tasks: [{ seatId: "seat-1", instruction: "提两个方案" }],
            exit: "wait-for-host",
          },
          { title: "执行", contextMode: "cumulative", tasks: [{ seatId: "seat-2", instruction: "执行选定的方案" }] },
        ],
      },
      { proxy: true },
    );
    await settledAgenda(table, teamId);
    expect(teamOf(table, teamId).agenda.confirmed?.standing).toBe("finished");
    expect(seatTurns(requests)[1]?.prompt).toContain("用方案二");
  });

  it("a proxy that cannot answer leaves the decision to the host, saying so", async () => {
    const { table, teamId } = setup(() => ({ text: "【结果】被卡住：缺数据" }), {
      proxy: async () => {
        throw new Error("模型没回");
      },
    });
    confirm(table, teamId, twoPhases, { proxy: true });
    await settledAgenda(table, teamId);
    expect(teamOf(table, teamId).agenda.confirmed?.standing).toBe("deciding");
    expect(table.transcript(teamId).some((line) => line.text.includes("Lil X 没能就"))).toBe(true);
  });
});
