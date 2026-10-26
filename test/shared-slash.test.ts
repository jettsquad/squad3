import { describe, expect, it } from "vitest";
import { parseSlash, SLASH_COMMANDS, slashCandidates } from "../src/shared/slash.ts";

describe("parseSlash", () => {
  it("reads a command and its arguments", () => {
    const parsed = parseSlash("/squad-say 甲,乙: 看一下");
    expect(parsed.kind).toBe("command");
    if (parsed.kind === "command") {
      expect(parsed.spec.name).toBe("squad-say");
      expect(parsed.args).toBe("甲,乙: 看一下");
    }
  });

  it("keeps multi-line arguments whole", () => {
    const parsed = parseSlash("/squad-say 第一行\n第二行");
    expect(parsed.kind === "command" && parsed.args).toBe("第一行\n第二行");
  });

  it("a sentence that merely starts with a slash is not a command", () => {
    // A path or a question about one goes to the team as written.
    expect(parseSlash("/etc/hosts 怎么改？").kind).toBe("none");
    expect(parseSlash("普通的一句话").kind).toBe("none");
  });

  it("names an unknown /squad- command rather than sending it to the team", () => {
    expect(parseSlash("/squad-nope")).toEqual({ kind: "unknown", name: "squad-nope" });
  });

  it("lists all eleven 2.x commands, the later ones marked with their phase", () => {
    expect(SLASH_COMMANDS).toHaveLength(11);
    expect(SLASH_COMMANDS.filter((command) => command.later !== undefined).map((command) => command.name)).toEqual([]);
  });
});

describe("slashCandidates", () => {
  it("offers commands for a partly typed name", () => {
    expect(slashCandidates("/squad-f").map((command) => command.name)).toEqual(["squad-fold"]);
    expect(slashCandidates("/").length).toBe(11);
  });

  it("offers nothing once arguments start", () => {
    expect(slashCandidates("/squad-say 你好")).toEqual([]);
  });
});
