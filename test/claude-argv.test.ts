// 移植自 Squad 2.x packages/seat-claude-code/test/argv.test.ts @ 8dcb903
/**
 * The fence is the reason this package exists, so it is tested as a floor
 * rather than as a default: a caller that supplies its own filter and forgets
 * about delegation must still not be able to open that door.
 */
import { describe, expect, it } from "vitest";
import { DELEGATION_TOOLS, buildArgv, seatDenials } from "../src/main/seats/claude-code/argv.ts";

const flagValues = (argv: readonly string[], flag: string): string[] => {
  const at = argv.indexOf(flag);
  if (at < 0) return [];
  const values: string[] = [];
  for (let index = at + 1; index < argv.length && !argv[index]!.startsWith("--"); index++) {
    values.push(argv[index]!);
  }
  return values;
};

describe("buildArgv", () => {
  it("denies delegation by default", () => {
    // 1.x's executor passed no tool restriction at all, which is why a
    // secretary there could invent a team of its own to do the work.
    expect(flagValues(buildArgv({ prompt: "x" }), "--disallowed-tools")).toEqual([...DELEGATION_TOOLS]);
  });

  it("keeps the delegation denial when the caller supplies its own denials", () => {
    const argv = buildArgv({ prompt: "x", toolFilter: { deny: ["Bash"] } });
    expect(flagValues(argv, "--disallowed-tools")).toEqual([...DELEGATION_TOOLS, "Bash"]);
  });

  it("keeps the delegation denial even inside an allow-list", () => {
    // The dangerous case: an allow-list reads like a complete statement of
    // what is permitted, so a caller writing one has no reason to think about
    // what they are NOT excluding.
    const argv = buildArgv({ prompt: "x", toolFilter: { allow: ["Read", "Task"] } });
    expect(flagValues(argv, "--allowed-tools")).toEqual(["Read", "Task"]);
    expect(flagValues(argv, "--disallowed-tools")).toContain("Task");
  });

  it("lets a composition lower the floor deliberately", () => {
    // Explicit and awkward on purpose. Removing the fence should look like a
    // decision in the config, not like an omission.
    expect(flagValues(buildArgv({ prompt: "x", alwaysDeny: [] }), "--disallowed-tools")).toEqual([]);
  });

  it("does not repeat a tool named in both places", () => {
    const argv = buildArgv({ prompt: "x", toolFilter: { deny: ["Task"] } });
    expect(flagValues(argv, "--disallowed-tools").filter((tool) => tool === "Task")).toHaveLength(1);
  });
});

describe("the rest of the command line", () => {
  it("asks for stream-json and partial messages", () => {
    // Partial messages are why an idle clock can tell a thinking seat from a
    // wedged one.
    const argv = buildArgv({ prompt: "x" });
    expect(argv).toContain("--include-partial-messages");
    expect(argv.slice(argv.indexOf("--output-format"))[1]).toBe("stream-json");
  });

  it("maps bypassPermissions onto the CLI's own flag", () => {
    const argv = buildArgv({ prompt: "x", permissionMode: "bypassPermissions" });
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--permission-mode");
  });

  it("passes persona as an APPEND, never a replacement", () => {
    // Replacing the CLI's system prompt would take its tool descriptions with
    // it, and a seat that cannot describe its own tools uses them badly.
    const argv = buildArgv({ prompt: "x", persona: "你重视可维护性。" });
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toBe("你重视可维护性。");
  });

  it("selects a model when one is given, and says nothing when not", () => {
    expect(buildArgv({ prompt: "x", model: "claude-opus-4" })).toContain("--model");
    expect(buildArgv({ prompt: "x" })).not.toContain("--model");
  });

  it("ignores a blank persona rather than passing an empty flag", () => {
    expect(buildArgv({ prompt: "x", persona: "   " })).not.toContain("--append-system-prompt");
  });
});

describe("续接已有会话", () => {
  it("--resume 带上 id", () => {
    // 省的是常驻前缀：新会话每次重建约 65,897 token 的缓存，续接后是 62。
    const argv = buildArgv({ prompt: "P", resumeSessionId: "sess-1" });
    expect(argv).toContain("--resume");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-1");
  });

  it("不续接时不出现这个标志", () => {
    expect(buildArgv({ prompt: "P" })).not.toContain("--resume");
    expect(buildArgv({ prompt: "P", resumeSessionId: "" })).not.toContain("--resume");
  });

  it("续接不影响权限模式和工具围栏", () => {
    const argv = buildArgv({ prompt: "P", resumeSessionId: "s", permissionMode: "plan" });
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("plan");
    expect(argv).toContain("--disallowed-tools");
  });
});

describe("宿主配置", () => {
  // `--setting-sources` 后面跟的是一个空字符串：不读任何一层设置文件。
  const isolated = (argv: readonly string[]): boolean =>
    argv.includes("--strict-mcp-config") && argv[argv.indexOf("--setting-sources") + 1] === "";

  it("默认关掉，不读宿主的配置", () => {
    // 这是默认值，而不是一个选项——实测：常驻前缀带宿主配置是 100,113
    // token，不带是 33,899，差额每次冷启动都按「建缓存」这一档付。
    const argv = buildArgv({ prompt: "x" });
    expect(isolated(argv)).toBe(true);
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("显式打开时让开", () => {
    const argv = buildArgv({ prompt: "x", hostCustomizations: true });
    expect(argv).not.toContain("--strict-mcp-config");
    expect(argv).not.toContain("--setting-sources");
  });

  it("false 和不给是同一件事", () => {
    // 这个轴的存储值多半是 undefined（老席位存的时候还没有这个字段），
    // 而「没选」必须和「选了不要」落在省钱的那一边。
    expect(isolated(buildArgv({ prompt: "x", hostCustomizations: false }))).toBe(true);
  });

  it("不用 --safe-mode：它会把我们特意给席位的两样东西一起关掉", () => {
    // 实测：--safe-mode 下 --mcp-config 的工具不出现，--plugin-dir 的 skill 也不出现。
    expect(buildArgv({ prompt: "x" })).not.toContain("--safe-mode");
    expect(buildArgv({ prompt: "x", mcpConfig: "{}", skillsPluginDir: "/p" })).not.toContain("--safe-mode");
  });

  it("不关 skill：--disable-slash-commands 会让共享的 skill 也看不见", () => {
    expect(buildArgv({ prompt: "x", skillsPluginDir: "/p" })).not.toContain("--disable-slash-commands");
    expect(buildArgv({ prompt: "x", mcpConfig: "{}" })).not.toContain("--disable-slash-commands");
  });

  it("跟续接、权限模式、工具围栏共存", () => {
    const argv = buildArgv({
      prompt: "x",
      resumeSessionId: "sess-1",
      permissionMode: "acceptEdits",
      toolFilter: { deny: ["Bash"] },
    });
    expect(isolated(argv)).toBe(true);
    expect(argv).toContain("--resume");
    expect(flagValues(argv, "--permission-mode")).toEqual(["acceptEdits"]);
    expect(flagValues(argv, "--disallowed-tools")).toContain("Task");
  });

  it("带着我们自己的工具时，隔离不变", () => {
    const argv = buildArgv({ prompt: "x", mcpConfig: "{}" });
    expect(isolated(argv)).toBe(true);
    expect(argv[argv.indexOf("--mcp-config") + 1]).toBe("{}");
  });
});

describe("共享 skill", () => {
  it("给了插件目录就传给席位", () => {
    const argv = buildArgv({ prompt: "x", skillsPluginDir: "/state/claude-skills-plugin" });
    expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe("/state/claude-skills-plugin");
  });

  it("没有共享 skill 时不传，席位照常启动", () => {
    expect(buildArgv({ prompt: "x" })).not.toContain("--plugin-dir");
    expect(buildArgv({ prompt: "x", skillsPluginDir: "" })).not.toContain("--plugin-dir");
  });

  it("读宿主配置的席位不另外给：它已经有宿主的全部 skill", () => {
    expect(buildArgv({ prompt: "x", hostCustomizations: true, skillsPluginDir: "/p" })).not.toContain("--plugin-dir");
  });
});

describe("seatDenials", () => {
  it("没允许派生子 agent，委派工具留在底线上", () => {
    expect(seatDenials(DELEGATION_TOOLS, false)).toEqual([...DELEGATION_TOOLS]);
  });

  it("创建时允许了，只拿掉委派工具，部署另外禁的照样禁", () => {
    expect(seatDenials([...DELEGATION_TOOLS, "Bash"], true)).toEqual(["Bash"]);
    expect(
      flagValues(buildArgv({ prompt: "x", alwaysDeny: seatDenials(DELEGATION_TOOLS, true) }), "--disallowed-tools"),
    ).toEqual([]);
  });
});
