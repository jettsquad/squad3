/**
 * The sub-agent count on a working seat: Claude Code's open Agent (formerly
 * Task) calls. Eight of them can run for an hour without a word of reply, and
 * the window says so instead of looking stuck (2026-10-23).
 */
import { describe, expect, it } from "vitest";
import { subagentsOf } from "../src/main/table/index.ts";

const open = (tool: string, id: string) => ({ id, tool, command: `${tool} x`, startedAt: 0, background: false });

describe("subagentsOf", () => {
  it("counts open Agent and Task calls, and nothing else", () => {
    expect(
      subagentsOf({
        received: 10,
        open: [open("Agent", "a"), open("Agent", "b"), open("Task", "c"), open("Bash", "d"), open("WebFetch", "e")],
      }),
    ).toBe(3);
  });

  it("is 0 for a seat that is not working or has nothing open", () => {
    expect(subagentsOf(undefined)).toBe(0);
    expect(subagentsOf({ received: 0, open: [] })).toBe(0);
  });
});
