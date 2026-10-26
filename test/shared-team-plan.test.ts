// 移植自 Squad 2.x packages/shared/test/team-plan.test.ts @ 8e96d9c
/**
 * A team plan arrives as JSON a model wrote, and it decides what gets BUILT.
 * Everything here is about the failures that survive parsing: a roster that
 * looks complete, a secretary pointing at nobody, a seat nothing ever calls.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_SEATS,
  agendaWithKeys,
  checkTeamPlan,
  parseTeamPlan,
  resolveOpeningAgenda,
  type TeamPlan,
  type TeamPlanSeat,
} from "../src/shared/team-plan.ts";

const seat = (over: Partial<TeamPlanSeat> = {}): TeamPlanSeat => ({
  key: "writer",
  displayName: "写作",
  role: "把定稿的选题写成文章",
  systemPrompt: "你负责成稿。你不选题，也不评审自己的稿子。",
  backend: "claude-code",
  secretaryCandidate: false,
  rationale: "有人要真的把字写出来。",
  ...over,
});

const clerk = seat({
  key: "clerk",
  displayName: "秘书",
  role: "收敛成 JSON",
  secretaryCandidate: true,
  rationale: "把讨论收敛成一份可确认的方案。",
});

/** A plan that passes everything, so each test can break exactly one thing. */
const plan = (over: Partial<TeamPlan> = {}): TeamPlan =>
  parseTeamPlan({
    teamName: "写文章赚钱",
    goal: "每周发两篇，三个月内跑通一条变现路径。",
    constraints: ["每周 6 小时", "小红书 + 公众号"],
    seats: [seat(), clerk],
    secretaryKey: "clerk",
    openingAgenda: {
      phases: [
        {
          title: "开工",
          contextMode: "cumulative",
          tasks: [
            { seatKey: "writer", instruction: "写一篇" },
            { seatKey: "clerk", instruction: "收个尾" },
          ],
        },
      ],
    },
    ...over,
  });

describe("parseTeamPlan", () => {
  it("accepts a well-formed plan and fills the optional lists", () => {
    const parsed = parseTeamPlan({
      teamName: "t",
      goal: "g",
      seats: [seat(), clerk],
      secretaryKey: "clerk",
      openingAgenda: {
        phases: [
          {
            title: "p",
            contextMode: "cumulative",
            tasks: [
              { seatKey: "writer", instruction: "i" },
              { seatKey: "clerk", instruction: "i" },
            ],
          },
        ],
      },
    });
    expect(parsed.constraints).toEqual([]);
    expect(parsed.risks).toEqual([]);
  });

  it("rejects unknown keys rather than ignoring them", () => {
    // A key the model invented is an instruction it believes it gave us.
    // Ignored, the plan reads as though that instruction was honoured.
    expect(() => plan({ seats: [{ ...seat(), model: "opus" } as unknown as TeamPlanSeat, clerk] })).toThrow();
  });

  it("rejects a seat with no system prompt", () => {
    // It is the only thing that agent reads every round; empty means the seat
    // was named but never actually specified.
    expect(() => plan({ seats: [seat({ systemPrompt: "" }), clerk] })).toThrow();
  });

  it("rejects a seat with no rationale", () => {
    expect(() => plan({ seats: [seat({ rationale: "" }), clerk] })).toThrow();
  });

  it("rejects a key that is not a slug", () => {
    // It becomes part of a template id and is matched by hand in the console.
    expect(() => plan({ seats: [seat({ key: "Writer One" }), clerk] })).toThrow();
  });

  it("rejects a plan whose agenda has no phases", () => {
    expect(() => plan({ openingAgenda: { phases: [] } } as unknown as Partial<TeamPlan>)).toThrow();
  });
});

describe("checkTeamPlan", () => {
  it("passes a plan that names only real seats and uses all of them", () => {
    expect(checkTeamPlan(plan())).toEqual([]);
  });

  it("catches a duplicate key", () => {
    const problems = checkTeamPlan(plan({ seats: [seat(), seat({ displayName: "写作二组" }), clerk] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe("seats[1].key");
    expect(problems[0]?.detail).toMatch(/重复/);
  });

  it("catches a duplicate display name", () => {
    // Caught here rather than at creation, which would refuse after the
    // templates are already written — and two members with one name are
    // indistinguishable in every later reading of the record.
    const problems = checkTeamPlan(plan({ seats: [seat(), seat({ key: "writer-2" }), clerk] }));
    expect(problems.map((p) => p.field)).toContain("seats[1].displayName");
  });

  it("catches a secretary who is not on the roster", () => {
    const problems = checkTeamPlan(plan({ secretaryKey: "nobody" }));
    expect(problems.map((p) => p.field)).toContain("secretaryKey");
    expect(problems[0]?.detail).toMatch(/不存在/);
  });

  it("catches a secretary the plan never cleared to be one", () => {
    // The agent library's rule one layer up: an agent whose instructions never
    // mentioned planning an agenda should not become the seat that plans one.
    const problems = checkTeamPlan(plan({ secretaryKey: "writer" }));
    expect(problems[0]?.field).toBe("secretaryKey");
    expect(problems[0]?.detail).toMatch(/secretaryCandidate/);
  });

  it("catches an agenda task addressed to a key that does not exist", () => {
    const problems = checkTeamPlan(
      plan({
        openingAgenda: {
          phases: [
            {
              title: "开工",
              contextMode: "cumulative",
              tasks: [
                { seatKey: "editor", instruction: "评审" },
                { seatKey: "writer", instruction: "写" },
                { seatKey: "clerk", instruction: "收尾" },
              ],
            },
          ],
        },
      }),
    );
    expect(problems.some((p) => p.detail.includes("editor"))).toBe(true);
  });

  it("catches a seat the opening agenda never calls", () => {
    // The check this file exists for. A short roster gets noticed when the
    // work comes back thin; a seat that is built and never called costs money
    // and nothing ever reports it.
    const problems = checkTeamPlan(
      plan({
        seats: [seat(), seat({ key: "editor", displayName: "评审", rationale: "有人要把关。" }), clerk],
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe("seats[1].key");
    expect(problems[0]?.detail).toMatch(/一次都没有被点到/);
  });

  it("catches a roster of one", () => {
    const problems = checkTeamPlan(
      plan({
        seats: [clerk],
        secretaryKey: "clerk",
        openingAgenda: {
          phases: [{ title: "p", contextMode: "cumulative", tasks: [{ seatKey: "clerk", instruction: "i" }] }],
        },
      }),
    );
    expect(problems[0]?.detail).toMatch(/不算一支团队/);
  });

  it("catches a roster that is too big", () => {
    const many = Array.from({ length: MAX_PLAN_SEATS + 1 }, (_, index) =>
      seat({ key: `seat-${index}`, displayName: `第${index}位`, rationale: "凑数。" }),
    );
    const problems = checkTeamPlan(
      plan({
        seats: [...many, clerk],
        openingAgenda: {
          phases: [
            {
              title: "开工",
              contextMode: "cumulative",
              tasks: [
                ...many.map((s) => ({ seatKey: s.key, instruction: "干活" })),
                { seatKey: "clerk", instruction: "收尾" },
              ],
            },
          ],
        },
      }),
    );
    expect(problems[0]?.field).toBe("seats");
    expect(problems[0]?.detail).toMatch(/太多/);
  });

  it("catches a bounded-rounds phase with no bound, through the agenda's own rule", () => {
    const problems = checkTeamPlan(
      plan({
        openingAgenda: {
          phases: [
            {
              title: "循环",
              contextMode: "cumulative",
              exit: "after-bounded-rounds",
              tasks: [
                { seatKey: "writer", instruction: "写" },
                { seatKey: "clerk", instruction: "收尾" },
              ],
            },
          ],
        },
      }),
    );
    expect(problems[0]?.field).toBe("openingAgenda");
    expect(problems[0]?.detail).toMatch(/maxRounds/);
  });

  it("catches a permission mode the backend has never heard of", () => {
    // It would be handed to the child process verbatim; the error would then
    // arrive from the CLI at the first round.
    const problems = checkTeamPlan(plan({ seats: [seat({ backend: "codex", permissionMode: "plan" }), clerk] }));
    expect(problems[0]?.field).toBe("seats[0].permissionMode");
  });

  it("accepts web access on codex, which Squad now opens for itself", () => {
    // It used to be rejected here, because codex's sandbox is shut by default
    // and a seat told to look something up answered from memory instead.
    // Squad passes `sandbox_workspace_write.network_access=true` when the seat
    // is allowed the web, so the combination is no longer a lie — and a plan
    // rejected for it would now be refusing a team that works.
    const problems = checkTeamPlan(plan({ seats: [seat({ backend: "codex", webAccess: true }), clerk] }));
    expect(problems).toEqual([]);
  });

  it("reports every problem at once rather than the first", () => {
    // A confirmation screen puts each complaint under the input that caused
    // it; one-at-a-time turns that screen into a queue.
    const problems = checkTeamPlan(plan({ seats: [seat(), seat(), clerk], secretaryKey: "nobody" }));
    expect(problems.length).toBeGreaterThan(1);
  });
});

describe("agendaWithKeys", () => {
  it("produces an agenda whose seat ids are the plan's keys", () => {
    expect(agendaWithKeys(plan()).phases[0]?.tasks[0]).toEqual({ seatId: "writer", instruction: "写一篇" });
  });
});

describe("resolveOpeningAgenda", () => {
  it("substitutes real seat ids once the team exists", () => {
    const agenda = resolveOpeningAgenda(
      plan(),
      new Map([
        ["writer", "seat-1"],
        ["clerk", "seat-2"],
      ]),
    );
    expect(agenda.phases[0]?.tasks.map((t) => t.seatId)).toEqual(["seat-1", "seat-2"]);
  });

  it("refuses an unmapped key rather than dropping the task", () => {
    // A dropped task reads at execution time as a seat that had nothing to
    // say — the exact reading this design exists to make impossible.
    expect(() => resolveOpeningAgenda(plan(), new Map([["writer", "seat-1"]]))).toThrow(/没有落地/);
  });
});
