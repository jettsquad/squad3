// 移植自 Squad 2.x packages/shared/test/agenda.test.ts @ 8dcb903
/**
 * An agenda arrives as JSON a model wrote. Everything here is about not
 * trusting it — and specifically about the failures that survive parsing and
 * only show up as silence much later.
 */
import { describe, expect, it } from "vitest";
import { checkAgendaAgainstRoster, parseAgendaSpec, type AgendaSpec } from "../src/shared/agenda.ts";

const phase = (over: Partial<AgendaSpec["phases"][number]> = {}): AgendaSpec["phases"][number] => ({
  title: "评审",
  contextMode: "independent",
  tasks: [{ seatId: "seat-a", instruction: "看一下设计" }],
  ...over,
});

const agenda = (...phases: AgendaSpec["phases"]): AgendaSpec => ({ phases });

describe("parseAgendaSpec", () => {
  it("accepts a minimal well-formed agenda", () => {
    expect(parseAgendaSpec({ phases: [phase()] }).phases).toHaveLength(1);
  });

  it("rejects unknown keys rather than ignoring them", () => {
    // Strict, because a key the model invented is a instruction it thinks it
    // gave us. Ignored, it looks like the agenda was followed.
    expect(() => parseAgendaSpec({ phases: [{ ...phase(), rounds: 3 }] })).toThrow();
  });

  it("rejects a phase with no tasks", () => {
    expect(() => parseAgendaSpec({ phases: [{ ...phase(), tasks: [] }] })).toThrow();
  });

  it("rejects an agenda with no phases", () => {
    expect(() => parseAgendaSpec({ phases: [] })).toThrow();
  });
});

describe("checkAgendaAgainstRoster", () => {
  it("passes an agenda that names only real seats", () => {
    expect(checkAgendaAgainstRoster(agenda(phase()), ["seat-a", "seat-b"])).toEqual([]);
  });

  it("catches a seat id the model invented", () => {
    // 1.x asked for this in the prompt and never checked. At execution time a
    // task nobody can run looks exactly like a seat that had nothing to say.
    const problems = checkAgendaAgainstRoster(agenda(phase({ tasks: [{ seatId: "seat-z", instruction: "看一下" }] })), [
      "seat-a",
    ]);
    expect(problems).toEqual([{ phase: "评审", detail: "点名了不存在的席位「seat-z」" }]);
  });

  it("catches a bounded-rounds phase with no bound", () => {
    // It parses. Then it repeats until something else stops it.
    const problems = checkAgendaAgainstRoster(agenda(phase({ exit: "after-bounded-rounds" })), ["seat-a"]);
    expect(problems[0]?.detail).toMatch(/没有给 maxRounds/);
  });

  it("catches a bound on a phase that does not repeat", () => {
    // Harmless-looking and never honoured, so the host would believe a limit
    // was in force that nothing reads.
    const problems = checkAgendaAgainstRoster(agenda(phase({ exit: "after-tasks", maxRounds: 3 })), ["seat-a"]);
    expect(problems[0]?.detail).toMatch(/exit 不是 after-bounded-rounds/);
  });

  it("reports every problem, not just the first", () => {
    const problems = checkAgendaAgainstRoster(
      agenda(
        phase({ tasks: [{ seatId: "seat-x", instruction: "一" }] }),
        phase({ title: "收敛", exit: "after-bounded-rounds" }),
      ),
      ["seat-a"],
    );
    expect(problems).toHaveLength(2);
  });
});

describe("phase situation labels", () => {
  it("accepts a phase labelled with a closed-list action and features", () => {
    const parsed = parseAgendaSpec({
      phases: [{ ...phase(), situation: { action: "design-mechanism", features: ["automatic"] } }],
    });
    expect(parsed.phases[0]?.situation?.action).toBe("design-mechanism");
  });

  it("defaults features to none rather than to undefined", () => {
    // A label with no features still keys a situation; leaving it undefined
    // would make "no features" and "not labelled" the same shape.
    const parsed = parseAgendaSpec({
      phases: [{ ...phase(), situation: { action: "adjudicate" } }],
    });
    expect(parsed.phases[0]?.situation?.features).toEqual([]);
  });

  it("refuses an action outside the closed list", () => {
    // Refused at draft time, before the host can confirm it. A label the
    // criteria library cannot read is a label about nothing, and it would
    // fail later as a phase that silently never matches anything.
    expect(() =>
      parseAgendaSpec({ phases: [{ ...phase(), situation: { action: "随便编一个", features: [] } }] }),
    ).toThrow();
  });

  it("refuses an invented feature flag", () => {
    expect(() =>
      parseAgendaSpec({
        phases: [{ ...phase(), situation: { action: "adjudicate", features: ["自作主张"] } }],
      }),
    ).toThrow();
  });

  it("leaves a phase without a label alone", () => {
    // Optional on purpose: an unlabelled phase gets no criteria, which is
    // today's behaviour rather than a failure.
    expect(parseAgendaSpec({ phases: [phase()] }).phases[0]).not.toHaveProperty("situation");
  });
});
