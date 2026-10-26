// 移植自 Squad 2.x packages/table/test/agenda.test.ts @ 8dcb903
/**
 * Expanding a phase. Every mistake available here is silent: one pass too few
 * reads as a team that converged, and the wrong snapshot reads as a member who
 * ignored what was said.
 */
import { describe, expect, it } from "vitest";
import type { AgendaPhase } from "../src/shared/index.ts";
import { outstandingWork, pausesAfter, planPhase, roundsOf, windowPolicyOf } from "../src/main/table/agenda.ts";

const phase = (over: Partial<AgendaPhase> = {}): AgendaPhase => ({
  title: "评审",
  contextMode: "independent",
  tasks: [
    { seatId: "seat-a", instruction: "甲说" },
    { seatId: "seat-b", instruction: "乙说" },
  ],
  ...over,
});

describe("roundsOf", () => {
  it("runs a plain phase once", () => {
    expect(roundsOf(phase())).toBe(1);
  });

  it("runs a bounded phase its stated number of times", () => {
    expect(roundsOf(phase({ exit: "after-bounded-rounds", maxRounds: 3 }))).toBe(3);
  });

  it("falls back to a single pass when a bounded phase has no bound", () => {
    // Vetting refuses this combination, so reaching it is already a bug — and
    // the safe reading of a bug about repetition is "repeat less".
    expect(roundsOf(phase({ exit: "after-bounded-rounds" }))).toBe(1);
  });
});

describe("windowPolicyOf", () => {
  const p = phase();

  it("gives every seat the phase-start snapshot in independent mode", () => {
    // Topology, not a promise: same snapshot for everyone means there is no
    // edge from one seat to another for anything to carry along.
    expect(windowPolicyOf(p, p.tasks[0]!)).toBe("phase-start");
  });

  it("gives each seat a fresh window in cumulative mode", () => {
    const c = phase({ contextMode: "cumulative" });
    expect(windowPolicyOf(c, c.tasks[0]!)).toBe("before-turn");
  });

  it("lets a task override its phase in either direction", () => {
    expect(
      windowPolicyOf(p, { seatId: "seat-a", instruction: "x", publicContextCutoff: "immediately-before-turn" }),
    ).toBe("before-turn");
    const c = phase({ contextMode: "cumulative" });
    expect(windowPolicyOf(c, { seatId: "seat-a", instruction: "x", publicContextCutoff: "phase-start" })).toBe(
      "phase-start",
    );
  });
});

describe("planPhase", () => {
  it("keeps task order within a round and repeats the whole list", () => {
    const runs = planPhase(phase({ exit: "after-bounded-rounds", maxRounds: 2 }));
    expect(runs.map((r) => `${r.round}:${r.task.seatId}`)).toEqual(["1:seat-a", "1:seat-b", "2:seat-a", "2:seat-b"]);
  });

  it("plans one run per task for an ordinary phase", () => {
    expect(planPhase(phase())).toHaveLength(2);
  });
});

describe("pausesAfter", () => {
  it("stops the agenda when the phase hands control back", () => {
    expect(pausesAfter(phase({ exit: "wait-for-host" }))).toBe(true);
    expect(pausesAfter(phase())).toBe(false);
  });
});

describe("outstandingWork", () => {
  const agenda = {
    hostGoal: "把评审做完",
    phases: [
      phase({ title: "初审", tasks: [{ seatId: "seat-a", instruction: "甲初审" }] }),
      phase({
        title: "复审",
        tasks: [
          { seatId: "seat-a", instruction: "甲复审" },
          { seatId: "seat-b", instruction: "乙复审" },
        ],
      }),
      phase({ title: "定稿", tasks: [{ seatId: "seat-a", instruction: "甲定稿" }] }),
    ],
  };

  it("owes nothing when every phase finished", () => {
    expect(outstandingWork(agenda, ["初审", "复审", "定稿"], [])).toEqual([]);
  });

  it("lists the unfinished tasks of a phase the stop cut through", () => {
    // The phase is not done, so it must contribute what is left of it —
    // disappearing because it was "in progress" would put those tasks in
    // neither column, and the hand-off would read as complete.
    expect(outstandingWork(agenda, ["初审"], ["甲复审"])).toEqual(["阶段「复审」：乙复审", "阶段「定稿」：甲定稿"]);
  });

  it("names a phase that never started without pretending to detail it", () => {
    expect(outstandingWork(agenda, [], [])[0]).toBe("阶段「初审」：甲初审");
  });

  it("still lists a phase whose tasks all ran but which never completed", () => {
    // Every task done and the phase not marked complete means the stop landed
    // between the last task and the phase closing. Reported as a phase with
    // nothing itemised, rather than dropped.
    expect(outstandingWork(agenda, [], ["甲初审"])).toContain("阶段「初审」");
  });
});
