/**
 * 「允许联网」 on a Claude Code seat has to reach the command line: the seat's
 * prompt says WebFetch is pre-approved, and in `claude -p` nobody is there to
 * approve anything that is not.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { webToolsFor } from "../src/main/seats/claude-code/adapter.ts";
import { buildArgv } from "../src/main/seats/claude-code/argv.ts";
import { DOWNLOAD_TOOL_NAME } from "../src/shared/agent-template.ts";

describe("webToolsFor", () => {
  it("off gives nothing", () => {
    expect(webToolsFor({ webAccess: false }, "C:\\p")).toEqual({});
    expect(webToolsFor({}, "C:\\p")).toEqual({});
  });

  it("on pre-approves the web tools and the download tool, and mounts the download server in the team's folder", () => {
    const given = webToolsFor({ webAccess: true }, join("C:", "team"));
    expect(given.toolFilter?.allow).toEqual(["WebFetch", "WebSearch", DOWNLOAD_TOOL_NAME]);
    const config = JSON.parse(given.mcpConfig ?? "{}") as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const server = config.mcpServers["squad-download"];
    expect(server?.args.at(-1)).toBe(join("C:", "team", "squad-downloads"));
    expect(server?.env["ELECTRON_RUN_AS_NODE"]).toBe("1");
  });

  it("reaches argv as --allowed-tools and --mcp-config", () => {
    const argv = buildArgv({ prompt: "p", promptViaStdin: true, ...webToolsFor({ webAccess: true }, "C:\\team") });
    expect(argv).toContain("--mcp-config");
    const allowed = argv.indexOf("--allowed-tools");
    expect(argv.slice(allowed + 1, allowed + 4)).toEqual(["WebFetch", "WebSearch", DOWNLOAD_TOOL_NAME]);
  });
});
