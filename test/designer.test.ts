// 移植自 Squad 2.x packages/console/test/team-designer.test.ts @ 8e96d9c
// 改动：latestPlanOf 读 3 的记录行（speaker/text/entryId，不再是「【名字】正文」），返回 entryId 而不是 turnId；
// 文末新增建团服务的测试（2.x 的 instantiateTeamPlan 只有 smoke 覆盖）。
/**
 * The seed is the designer team AND a specimen of the format it produces, so
 * the first test here is the one that matters: it has to pass its own check.
 * A seed that could not be instantiated would be a designer that cannot
 * design itself.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTeamPlan, parseTeamPlan, resolveOpeningAgenda, type TeamPlan } from "../src/shared/index.ts";
import { describe, expect, it } from "vitest";
import { createContext } from "../src/main/context/index.ts";
import { createLibrary } from "../src/main/library/index.ts";
import { resetSeatSessions } from "../src/main/seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest, Seats } from "../src/main/seats/index.ts";
import { createSecretary } from "../src/main/secretary/index.ts";
import { createStore } from "../src/main/store/index.ts";
import { createTable, type Table } from "../src/main/table/index.ts";
import { createVault, type Cipher } from "../src/main/vault/index.ts";
import {
  TEAM_DESIGNER_PLAN,
  createDesigner,
  designerAgendaFor,
  latestPlanOf,
  planFromReply,
  planHash,
  templateIdFor,
  templatesFor,
} from "../src/main/designer/index.ts";

describe("TEAM_DESIGNER_PLAN", () => {
  it("parses under the same strict schema as anything a model writes", () => {
    expect(() => parseTeamPlan(TEAM_DESIGNER_PLAN)).not.toThrow();
  });

  it("passes checkTeamPlan", () => {
    expect(checkTeamPlan(TEAM_DESIGNER_PLAN)).toEqual([]);
  });

  it("keeps the two rosters blind to each other, and lets the reporter see both", () => {
    // The whole reason this is a team rather than a prompt: the architect and
    // the red team write their rosters without seeing each other. Seeing the
    // first answer turns the second into a comment on it.
    //
    // The seat that REPORTS both to the host is the exception, and it has to
    // be an explicit one: in an independent phase every run shares the
    // opening snapshot, so a summariser left on the default would be
    // describing two rosters it cannot see.
    const phase = TEAM_DESIGNER_PLAN.openingAgenda.phases[1];
    expect(phase?.contextMode).toBe("independent");
    expect(phase?.tasks.map((task) => task.seatKey)).toEqual(["architect", "redteam", "clarifier"]);
    expect(phase?.tasks[0]?.publicContextCutoff).toBeUndefined();
    expect(phase?.tasks[1]?.publicContextCutoff).toBeUndefined();
    expect(phase?.tasks[2]?.publicContextCutoff).toBe("immediately-before-turn");
  });

  it("stops for the host again once the shape of the roster is visible", () => {
    // The cheapest moment to catch 「我要的是团队主笔，这给的却是一圈辅助」.
    // Five phases later it is only fixable by throwing the plan away.
    expect(TEAM_DESIGNER_PLAN.openingAgenda.phases[1]?.exit).toBe("wait-for-host");
  });

  it("stops for the host before designing anything", () => {
    // Hours per week, existing accounts, what the host is actually good at:
    // facts no model has a route to. A team that guesses them designs for a
    // person who does not exist.
    expect(TEAM_DESIGNER_PLAN.openingAgenda.phases[0]?.exit).toBe("wait-for-host");
  });

  it("tells every seat it is designing somebody else's team", () => {
    // The worst failure this thing has had: the designer team decided it was
    // designing ITSELF — 「主笔落到哪个头上？让提示词工程兼任」. A seat's own
    // job description never says whose roster it is; with five colleagues in
    // front of it and no other roster in sight, a model maps the work onto
    // them. The frame has to be on every seat, before its job.
    for (const seat of TEAM_DESIGNER_PLAN.seats) {
      expect(seat.systemPrompt, seat.displayName).toContain("不是被设计的对象");
      expect(seat.systemPrompt, seat.displayName).toContain("全部是新造的");
    }
  });

  it("gives every seat a boundary", () => {
    // Seats without one overlap, and four overlapping seats produce four
    // copies of one answer — which reads as agreement, not as redundancy.
    for (const seat of TEAM_DESIGNER_PLAN.seats) {
      expect(seat.systemPrompt, seat.displayName).toContain("你不做什么");
    }
  });

  it("names exactly one secretary, and it is cleared to be one", () => {
    const candidates = TEAM_DESIGNER_PLAN.seats.filter((seat) => seat.secretaryCandidate);
    expect(candidates.map((seat) => seat.key)).toEqual([TEAM_DESIGNER_PLAN.secretaryKey]);
  });
});

describe("planHash", () => {
  it("ignores key order, because two spellings of one plan are one plan", () => {
    const reordered = { ...TEAM_DESIGNER_PLAN };
    expect(planHash(reordered)).toBe(planHash(TEAM_DESIGNER_PLAN));
  });

  it("changes when the plan does", () => {
    expect(planHash({ ...TEAM_DESIGNER_PLAN, teamName: "别的" })).not.toBe(planHash(TEAM_DESIGNER_PLAN));
  });
});

describe("templateIdFor", () => {
  it("suffixes rather than overwriting an id that is taken", () => {
    // The agent library is shared across teams. A template quietly edited
    // here fails somewhere else, weeks later, with nothing connecting the two.
    const id = templateIdFor("writer", "abcdef0123", (candidate) => candidate === "plan-writer-abcdef");
    expect(id).toBe("plan-writer-abcdef-2");
  });
});

describe("templatesFor", () => {
  const templates = templatesFor(TEAM_DESIGNER_PLAN, () => false);

  it("mints one live template per seat, in roster order", () => {
    expect(templates).toHaveLength(TEAM_DESIGNER_PLAN.seats.length);
    expect(templates.map((t) => t.displayName)).toEqual(TEAM_DESIGNER_PLAN.seats.map((s) => s.displayName));
    expect(templates.every((t) => t.enabled)).toBe(true);
  });

  it("never mints the same id twice inside one plan", () => {
    expect(new Set(templates.map((t) => t.templateId)).size).toBe(templates.length);
  });

  it("clears the planned secretary to be one", () => {
    const secretary = templates[TEAM_DESIGNER_PLAN.seats.findIndex((s) => s.key === TEAM_DESIGNER_PLAN.secretaryKey)];
    expect(secretary?.secretaryCandidate).toBe(true);
  });
});

describe("resolveOpeningAgenda over the seed", () => {
  it("addresses every task to a real seat once the team exists", () => {
    const map = new Map(TEAM_DESIGNER_PLAN.seats.map((seat, index) => [seat.key, `seat-${index + 1}`]));
    const agenda = resolveOpeningAgenda(TEAM_DESIGNER_PLAN, map);
    const addressed = agenda.phases.flatMap((phase) => phase.tasks.map((task) => task.seatId));
    expect(addressed.every((seatId) => /^seat-\d+$/.test(seatId))).toBe(true);
  });
});

describe("planFromReply", () => {
  const wire = JSON.stringify(TEAM_DESIGNER_PLAN);

  it("reads a plan the secretary wrapped in prose and a code fence", () => {
    // The failure being avoided is a perfectly good plan refused because the
    // model said 「给你：」 first.
    expect(planFromReply("给你：\n```json\n" + wire + "\n```\n就这些。").teamName).toBe(TEAM_DESIGNER_PLAN.teamName);
  });

  it("refuses a reply with no object in it", () => {
    expect(() => planFromReply("我觉得应该找四个人，一个选题一个写作。")).toThrow(/没有 JSON 对象/);
  });

  it("refuses a plan that parses but cannot be built", () => {
    // The whole point of checking here: otherwise the host confirms a roster
    // and finds out at the moment the templates are already half-written.
    const orphaned = { ...TEAM_DESIGNER_PLAN, secretaryKey: "nobody" };
    expect(() => planFromReply(JSON.stringify(orphaned))).toThrow(/secretaryKey/);
  });
});

describe("latestPlanOf", () => {
  const line = (speaker: string, text: string, turnId: string) => ({
    speaker,
    text,
    entryId: turnId,
  });

  it("takes the secretary's most recent readable plan", () => {
    const plan = latestPlanOf({
      secretary: { displayName: "组队秘书" },
      transcript: () => [
        line("组队秘书", JSON.stringify({ ...TEAM_DESIGNER_PLAN, teamName: "旧的" }), "t1"),
        line("红队", "我反对。", "t2"),
        line("组队秘书", JSON.stringify({ ...TEAM_DESIGNER_PLAN, teamName: "新的" }), "t3"),
      ],
    });
    expect(plan.plan.teamName).toBe("新的");
    expect(plan.entryId).toBe("t3");
  });

  it("ignores a plan written by somebody who is not the secretary", () => {
    // Any seat can be asked to propose a division of labour. Building a team
    // out of one of those would let a member staff the next team while the
    // confirmation said the secretary had.
    expect(() =>
      latestPlanOf({
        secretary: { displayName: "组队秘书" },
        transcript: () => [line("红队", JSON.stringify(TEAM_DESIGNER_PLAN), "t1")],
      }),
    ).toThrow(/还没有给出过团队方案/);
  });

  it("says what was wrong when the secretary did speak but the plan will not build", () => {
    // 「没找到方案」 on its own reads as 「秘书还没说过」, and the truth is
    // usually 「说过，但差一样东西」.
    expect(() =>
      latestPlanOf({
        secretary: { displayName: "组队秘书" },
        transcript: () => [line("组队秘书", JSON.stringify({ ...TEAM_DESIGNER_PLAN, secretaryKey: "nobody" }), "t1")],
      }),
    ).toThrow(/secretaryKey/);
  });
});

describe("designerAgendaFor", () => {
  const roster = TEAM_DESIGNER_PLAN.seats.map((seat, index) => ({
    seatId: `seat-${index + 1}`,
    displayName: seat.displayName,
    templateId: `plan-${seat.key}-abc123`,
  }));

  it("addresses the five phases to an existing table", () => {
    // A sitting starts with no draft on purpose. The five phases are not a
    // decision somebody has to make again, though — they are the same
    // every time.
    const agenda = designerAgendaFor({ seats: roster });
    expect(agenda.phases).toHaveLength(TEAM_DESIGNER_PLAN.openingAgenda.phases.length);
    expect(agenda.phases[1]?.tasks.map((t) => t.seatId)).toEqual(["seat-2", "seat-4", "seat-1"]);
  });

  it("falls back to the display name when the template is gone", () => {
    const agenda = designerAgendaFor({ seats: roster.map(({ seatId, displayName }) => ({ seatId, displayName })) });
    expect(agenda.phases[0]?.tasks[0]?.seatId).toBe("seat-1");
  });

  it("refuses a table that is missing one of the five", () => {
    // Four phases that run and one that does not would look like it worked.
    expect(() => designerAgendaFor({ seats: roster.slice(0, 4) })).toThrow(/组队秘书/);
  });
});

// ── 3: the build service, on a real table, store and agent library ─────────

const cipher: Cipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(plain, "utf8").reverse(),
  decrypt: (sealed) => Buffer.from(sealed).reverse().toString("utf8"),
};

function service(answer: (request: SeatRequest) => string = () => "好的") {
  resetSeatSessions();
  const dataDir = mkdtempSync(join(tmpdir(), "squad-designer-"));
  const folder = (): string => mkdtempSync(join(tmpdir(), "squad-designed-"));
  const store = createStore(dataDir);
  const library = createLibrary({ dataDir, vault: createVault({ dataDir, cipher, env: {} }) });
  const requests: SeatRequest[] = [];
  const adapter: SeatAdapter = {
    backend: "claude-code",
    capabilities: { persona: true, resume: false },
    start: (request) => {
      requests.push(request);
      const text = answer(request);
      return {
        result: Promise.resolve({ text, failed: false, cancelled: false, exitCode: 0, durationMs: 1 }),
        cancel: () => undefined,
      };
    },
  };
  const seats: Seats = { adapterFor: () => adapter };
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
      template: (templateId) => library.agents.get(templateId),
      hasConnection: (connectionId) => library.connections.get(connectionId),
      resolveConnection: () => {
        throw new Error("测试里没有连接。");
      },
      hostDisplayName: () => "阿明",
    },
  });
  late.table = table;
  const designer = createDesigner({ table, agents: library.agents });
  const teamOf = (teamId: string) => table.list().teams.find((team) => team.teamId === teamId)!;
  return { table, library, designer, folder, teamOf, requests };
}

async function settled(table: Table, teamId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!table.list().teams.find((team) => team.teamId === teamId)!.busy) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("一直没有答完。");
}

/** A small plan of the kind the designer's secretary writes. */
const twoSeats: TeamPlan = parseTeamPlan({
  teamName: "写作组",
  goal: "每周发两篇能过审的文章。",
  constraints: ["分工基线：团队产出"],
  seats: [
    {
      key: "writer",
      displayName: "主笔",
      role: "写成稿",
      systemPrompt: "你写成稿。你不做什么：不审稿。",
      backend: "claude-code",
      secretaryCandidate: true,
      rationale: "要有人把文章写出来。",
    },
    {
      key: "reviewer",
      displayName: "审稿",
      role: "判断能不能过审",
      systemPrompt: "你判断能不能过审。你不做什么：不改稿。",
      backend: "codex",
      secretaryCandidate: false,
      webAccess: true,
      rationale: "要有人回答「能不能发」。",
    },
  ],
  secretaryKey: "writer",
  openingAgenda: {
    phases: [
      {
        title: "第一篇",
        contextMode: "cumulative",
        tasks: [
          { seatKey: "writer", instruction: "写第一篇。" },
          { seatKey: "reviewer", instruction: "审第一篇。" },
        ],
      },
    ],
  },
  risks: ["平台规则会变。"],
});

/** A designer team whose secretary has just answered with `reply`. */
async function designerWith(reply: string) {
  const parts = service((request) => (request.seat.displayName === "组队秘书" ? reply : "好的"));
  const built = parts.designer.createDesignerTeam(parts.folder());
  parts.table.say(built.teamId, "@组队秘书 出方案");
  await settled(parts.table, built.teamId);
  const entryId = parts.table.transcript(built.teamId).findLast((line) => line.speaker === "组队秘书")!.entryId;
  return { ...parts, designerId: built.teamId, entryId };
}

describe("the designer team, built", () => {
  it("is five seats from the seed, with the five phases up as a DRAFT and where it came from in the audit", () => {
    const { designer, folder, teamOf, library } = service();
    const built = designer.createDesignerTeam(folder());
    const team = teamOf(built.teamId);
    expect(team.seats.map((seat) => seat.displayName)).toEqual(TEAM_DESIGNER_PLAN.seats.map((s) => s.displayName));
    expect(team.seats.find((seat) => seat.isSecretary)?.displayName).toBe("组队秘书");
    expect(team.agenda.draft?.agenda.phases).toHaveLength(5);
    expect(team.agenda.confirmed).toBeUndefined();
    // Put up by the program, and said so: the secretary never wrote it.
    expect(team.agenda.draft?.author).toBe("designer-seed");
    expect(team.audit.find((entry) => entry.kind === "agenda-drafted")?.detail).toMatch(/^组队团队的种子议程拟了/);
    expect(built.templateIds.every((id) => library.agents.get(id) !== undefined)).toBe(true);
    const origin = team.audit.find((entry) => entry.kind === "team-origin");
    expect(origin?.detail).toContain("组队团队种子");
    expect(origin?.detail).toContain(built.hash.slice(0, 12));
    expect(designer.status(built.teamId).designer).toBe(true);
  });

  it("refuses a folder another team already lives in, naming that team", () => {
    const { designer, folder } = service();
    const shared = folder();
    designer.createDesignerTeam(shared);
    expect(() => designer.createDesignerTeam(shared)).toThrow(/「组队团队」已经住在/);
  });

  it("puts the five phases back up on request, and refuses a team that is not one", () => {
    const { designer, table, folder, teamOf } = service();
    const built = designer.createDesignerTeam(folder());
    const first = teamOf(built.teamId).agenda.draft!;
    table.resolveAgenda(built.teamId, { kind: "discard", agendaId: first.agendaId, revision: first.revision });
    designer.placeAgenda(built.teamId);
    expect(teamOf(built.teamId).agenda.draft?.agenda.phases).toHaveLength(5);
    const plain = table.create({
      displayName: "普通",
      projectFolder: folder(),
      seats: [{ displayName: "甲", role: "工程师", systemPrompt: "我是甲。", backend: "claude-code" }],
    });
    expect(designer.status(plain.teamId).designer).toBe(false);
    expect(() => designer.placeAgenda(plain.teamId)).toThrow(/放不了组队议程/);
  });
});

describe("a plan in the record", () => {
  it("is offered under the secretary's reply, and builds a team whose first agenda is a draft", async () => {
    const { designer, designerId, entryId, folder, teamOf } = await designerWith(
      "给你：\n```json\n" + JSON.stringify(twoSeats) + "\n```",
    );
    expect(designer.status(designerId).plans).toEqual([{ entryId, ok: true }]);
    expect(designer.preview(designerId, entryId).teamName).toBe("写作组");
    const built = designer.build(designerId, entryId, folder());
    const team = teamOf(built.teamId);
    expect(team.seats.map((seat) => [seat.displayName, seat.backend, seat.isSecretary])).toEqual([
      ["主笔", "claude-code", true],
      ["审稿", "codex", false],
    ]);
    const draft = team.agenda.draft?.agenda.phases[0]?.tasks.map((task) => task.seatId);
    expect(draft).toEqual(team.seats.map((seat) => seat.seatId));
    expect(team.agenda.draft?.author).toBe("plan-opening");
    expect(team.audit.find((entry) => entry.kind === "team-origin")?.detail).toMatch(/按「组队团队」秘书的方案建团/);
  });

  it("says why a plan that parses cannot be built, instead of offering nothing", async () => {
    const broken = { ...twoSeats, secretaryKey: "reviewer" };
    const { designer, designerId, entryId } = await designerWith(JSON.stringify(broken));
    const [offer] = designer.status(designerId).plans;
    expect(offer).toMatchObject({ entryId, ok: false });
    expect(offer?.ok === false && offer.detail).toMatch(/secretaryCandidate/);
  });

  it("builds only from the secretary's own reply", async () => {
    const { designer, designerId, table } = await designerWith(JSON.stringify(twoSeats));
    const host = table.transcript(designerId).find((line) => line.kind === "host")!;
    expect(() => designer.build(designerId, host.entryId, "x")).toThrow(/只能按秘书自己写的方案建团/);
  });

  it("an edit by the host is checked whole again, and the audit carries both fingerprints", async () => {
    const { designer, designerId, entryId, folder, teamOf } = await designerWith(JSON.stringify(twoSeats));
    const renamed = {
      ...twoSeats,
      seats: twoSeats.seats.map((s) => (s.key === "writer" ? { ...s, displayName: "执笔" } : s)),
    };
    const built = designer.build(designerId, entryId, folder(), renamed);
    const team = teamOf(built.teamId);
    expect(team.seats[0]?.displayName).toBe("执笔");
    const origin = team.audit.find((entry) => entry.kind === "team-origin")?.detail ?? "";
    expect(origin).toContain("经主持人修改");
    expect(origin).toContain(planHash(twoSeats).slice(0, 12));
    // A form can produce a roster that cannot be built as well as a model can.
    const twins = { ...twoSeats, seats: twoSeats.seats.map((s) => ({ ...s, displayName: "同名" })) };
    expect(() => designer.build(designerId, entryId, folder(), twins)).toThrow(/名字「同名」/);
  });

  it("a build that fails after the templates are written says which templates are left", async () => {
    const { designer, designerId, entryId, library } = await designerWith(JSON.stringify(twoSeats));
    const missing = join(tmpdir(), `squad-nowhere-${Date.now()}`);
    let said = "";
    try {
      designer.build(designerId, entryId, missing);
    } catch (error) {
      said = (error as Error).message;
    }
    expect(said).toMatch(/不存在/);
    expect(said).toMatch(/已经建好的 Agent 没有回滚/);
    const left = library.agents.list().filter((template) => template.templateId.startsWith("plan-writer-"));
    expect(left).toHaveLength(1);
  });

  it("asks the secretary again with the shape and the host's note, as a command addressed to it", async () => {
    const { designer, designerId, table, requests } = await designerWith("还不能成稿。");
    designer.redraft(designerId, "主笔要两个人");
    await settled(table, designerId);
    const last = requests.at(-1)!;
    expect(last.seat.displayName).toBe("组队秘书");
    expect(last.prompt).toContain('"secretaryKey"');
    expect(last.prompt).toContain("主笔要两个人");
    // Under the host's name, but the program's words: tagged, so nothing learns the host's standards from it.
    const sent = table.transcript(designerId).findLast((line) => line.kind === "host");
    expect(sent?.sentFor).toBe("plan-redraft");
  });
});

describe("refreshing the designer's seats", () => {
  it("rewrites the five prompts from the seed and keeps the host's own choices", () => {
    const { designer, folder, library, teamOf } = service();
    const built = designer.createDesignerTeam(folder());
    const clerk = teamOf(built.teamId).seats.find((seat) => seat.displayName === "组队秘书")!;
    const template = library.agents.get(clerk.templateId!)!;
    library.agents.save({ ...template, systemPrompt: "旧的提示词", permissionMode: "plan" });
    expect(designer.refresh(built.teamId)).toHaveLength(5);
    const after = library.agents.get(clerk.templateId!)!;
    expect(after.systemPrompt).toContain("TeamPlan JSON");
    expect(after.permissionMode).toBe("plan");
  });
});
