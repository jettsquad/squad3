// 移植自 Squad 2.x packages/secretary/test/termination.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import {
  TERMINATION_SUMMARY_HEADINGS,
  buildTeamAgendaTerminationPrompt,
  validateTeamAgendaTerminationSummary,
} from "../src/main/secretary/termination.ts";

const input = {
  objective: "选型数据库",
  reason: "甲的 token 用尽",
  completed: ["确认放弃自建"],
  remaining: ["压测 Postgres"],
  artifacts: ["docs/review.md"],
  discussion: ["【甲】我倾向 Postgres"],
};

describe("buildTeamAgendaTerminationPrompt", () => {
  // The document exists so a replacement agenda knows where to pick up. Every
  // field it needs must reach the secretary, because the secretary sees only
  // what it is handed.
  it("carries the objective, the reason, and both work lists", () => {
    const prompt = buildTeamAgendaTerminationPrompt(input);
    expect(prompt).toContain("选型数据库");
    expect(prompt).toContain("甲的 token 用尽");
    expect(prompt).toContain("确认放弃自建");
    expect(prompt).toContain("压测 Postgres");
  });

  it("lists the files that were actually written, so the index cites real paths", () => {
    expect(buildTeamAgendaTerminationPrompt(input)).toContain("docs/review.md");
  });

  it("says 无 rather than leaving a section blank", () => {
    const empty = buildTeamAgendaTerminationPrompt({
      ...input,
      completed: [],
      remaining: [],
      artifacts: [],
      discussion: [],
    });
    expect(empty.match(/无/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  // A summary that invented a completed item or a file would send the next
  // agenda somewhere that does not exist.
  it("forbids inventing completions, files, or reasons", () => {
    expect(buildTeamAgendaTerminationPrompt(input)).toContain("不要编造");
  });

  it("states all five headings so the reply can be validated", () => {
    const prompt = buildTeamAgendaTerminationPrompt(input);
    for (const heading of TERMINATION_SUMMARY_HEADINGS) expect(prompt).toContain(heading);
  });
});

describe("validateTeamAgendaTerminationSummary", () => {
  const wellFormed = TERMINATION_SUMMARY_HEADINGS.map((h) => `${h}\n内容`).join("\n\n");

  it("accepts a summary carrying every heading", () => {
    expect(validateTeamAgendaTerminationSummary(wellFormed)).toEqual({ ok: true });
  });

  // A hand-off with a section missing is worse than none: the next agenda
  // reads it as complete and silently starts from the wrong place.
  it("names every missing heading rather than failing vaguely", () => {
    const result = validateTeamAgendaTerminationSummary("## 议程目标\n只有一个标题");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual([...TERMINATION_SUMMARY_HEADINGS].slice(1));
  });

  it("refuses an empty reply", () => {
    const result = validateTeamAgendaTerminationSummary("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toHaveLength(TERMINATION_SUMMARY_HEADINGS.length);
  });
});
