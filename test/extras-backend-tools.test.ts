// 移植自 Squad 2.x packages/console/test/backend-tools.test.ts @ 8e96d9c
// 改动：dsh 不能一键升级的理由在 3 里换了（见 describeTool），那一条断言跟着改；文末加 Windows 布局的用例。
/**
 * 后端工具的版本与升级方式。
 *
 * 这里的每一条都对应一次真实踩过的坑：路径看着像 Homebrew 其实是 npm 装的；
 * 三个 CLI 的 --version 各说各的；预发布版本的先后；以及 dsh 不能照着另外两个
 * 的办法升。
 */
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  describeTool,
  installMethodOf,
  newestDshTag,
  npmPrefixOf,
  parseVersion,
  upgradeArgv,
  programOf,
} from "../src/main/extras/backend-tools.ts";

const CODEX = "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js";
const CLAUDE = "/Users/me/.local/share/claude/versions/2.1.294";
const DSH = "/Users/me/.local/share/roundtable/deepseek-harness/apps/cli/lib/bin.js";

describe("parseVersion", () => {
  it("三个 CLI 各说各的，都认得出来", () => {
    expect(parseVersion("codex-cli 0.162.0")).toBe("0.162.0");
    expect(parseVersion("2.1.294 (Claude Code)")).toBe("2.1.294");
    expect(parseVersion("0.1.2-alpha.5\n")).toBe("0.1.2-alpha.5");
  });

  it("报错不是版本号", () => {
    // 装坏了的 codex 打印的是一段堆栈，里面没有版本。
    expect(parseVersion("Error: Missing optional dependency @openai/codex-darwin-arm64.")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("按数字比，不按字符串比", () => {
    expect(compareVersions("0.153.4", "0.162.0")).toBeLessThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("2.1.295", "2.1.294")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("正式版比它自己的预发布版新", () => {
    expect(compareVersions("0.162.0-alpha.2", "0.162.0")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.2.0-rc.2")).toBeGreaterThan(0);
  });

  it("预发布版之间逐段比", () => {
    expect(compareVersions("0.1.2-alpha.5", "0.1.2-alpha.10")).toBeLessThan(0);
    expect(compareVersions("0.2.0-rc.1", "0.2.0-rc.2")).toBeLessThan(0);
    expect(compareVersions("0.2.0-alpha.9", "0.2.0-rc.1")).toBeLessThan(0);
    expect(compareVersions("0.1.2-alpha.5", "0.2.1-alpha.1")).toBeLessThan(0);
  });
});

describe("installMethodOf", () => {
  it("看真实路径，不看 PATH 上的名字", () => {
    // /opt/homebrew/bin/codex 看着像 Homebrew 装的，其实是 npm 全局包的软链。
    // 第一次升级它用的是 brew upgrade codex，什么都没发生。
    expect(installMethodOf("codex", CODEX)).toBe("npm-global");
    expect(installMethodOf("claude-code", CLAUDE)).toBe("native");
    expect(installMethodOf("claude-code", "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe(
      "npm-global",
    );
    expect(installMethodOf("dsh", DSH)).toBe("git-checkout");
  });

  it("认不出来就说认不出来", () => {
    expect(installMethodOf("codex", "/opt/homebrew/Caskroom/codex/0.162.0/codex")).toBe("unknown");
  });
});

describe("upgradeArgv", () => {
  it("按安装方式给命令", () => {
    expect(upgradeArgv("codex", "npm-global")).toEqual({
      command: "npm",
      args: ["install", "-g", "@openai/codex@latest"],
    });
    expect(upgradeArgv("claude-code", "native")).toEqual({ command: "claude", args: ["update"] });
    expect(upgradeArgv("claude-code", "npm-global")).toEqual({
      command: "npm",
      args: ["install", "-g", "@anthropic-ai/claude-code@latest"],
    });
  });

  it("dsh 没有一键升级", () => {
    // 3 里它是一份源码目录（席位后端，不再是 Squad 的底座）：升级是拉代码再构建，不替人做。
    expect(upgradeArgv("dsh", "git-checkout")).toBeUndefined();
  });

  it("认不出安装方式就不猜", () => {
    expect(upgradeArgv("codex", "unknown")).toBeUndefined();
  });

  it("升级装回原来那棵 npm 树", () => {
    expect(npmPrefixOf(CODEX)).toBe("/opt/homebrew");
    expect(npmPrefixOf(CLAUDE)).toBeUndefined();
  });
});

describe("newestDshTag", () => {
  it("从 ls-remote 里挑出最新的 dsh 版本", () => {
    const output = [
      "aaa\trefs/tags/dsh-v0.1.2-alpha.5",
      "bbb\trefs/tags/dsh-v0.2.0-rc.2",
      "ccc\trefs/tags/dsh-v0.2.1-alpha.1",
      "ddd\trefs/tags/dsh-v0.2.1-alpha.1^{}",
      "eee\trefs/tags/something-else-v9.9.9",
    ].join("\n");
    expect(newestDshTag(output)).toBe("0.2.1-alpha.1");
    expect(newestDshTag("")).toBeUndefined();
  });
});

describe("describeTool", () => {
  it("有新版、认得安装方式：给按钮，也给命令", () => {
    const status = describeTool({ tool: "codex", resolvedPath: CODEX, installed: "0.153.4", latest: "0.162.0" });
    expect(status).toMatchObject({
      outdated: true,
      canUpgrade: true,
      method: "npm-global",
      upgradeCommand: "npm install -g @openai/codex@latest",
    });
    expect(status.problem).toBeUndefined();
  });

  it("已是最新：没有按钮", () => {
    const status = describeTool({ tool: "codex", resolvedPath: CODEX, installed: "0.162.0", latest: "0.162.0" });
    expect(status.outdated).toBe(false);
    expect(status.canUpgrade).toBe(false);
  });

  it("本机比源上的还新（预发布）：不算过期", () => {
    const status = describeTool({
      tool: "codex",
      resolvedPath: CODEX,
      installed: "0.163.0-alpha.1",
      latest: "0.162.0",
    });
    expect(status.outdated).toBe(false);
  });

  it("装坏了、报不出版本：给重装的按钮", () => {
    // npm 报告升级成功，codex 却一运行就报缺平台包——同一条命令能把它装回来。
    const status = describeTool({ tool: "codex", resolvedPath: CODEX, latest: "0.162.0" });
    expect(status.canUpgrade).toBe(true);
    expect(status.problem).toContain("装坏了");
  });

  it("dsh 有新版：说明为什么不能直接升，不给按钮", () => {
    const status = describeTool({
      tool: "dsh",
      resolvedPath: DSH,
      installed: "0.1.2-alpha.5",
      latest: "0.2.1-alpha.1",
    });
    expect(status.outdated).toBe(true);
    expect(status.canUpgrade).toBe(false);
    // 3：理由换成「源码目录」——dsh 在 3 里不是 Squad 的底座，说「底座」就是假话。
    expect(status.problem).toContain("源码目录");
  });

  it("查不到最新版本：照样显示本机版本，并说明原因", () => {
    const status = describeTool({ tool: "claude-code", resolvedPath: CLAUDE, installed: "2.1.294" });
    expect(status.installed).toBe("2.1.294");
    expect(status.canUpgrade).toBe(false);
    expect(status.problem).toContain("查不到");
  });

  it("没装：说没找到", () => {
    const status = describeTool({ tool: "codex" });
    expect(status.canUpgrade).toBe(false);
    expect(status.problem).toContain("没有找到 codex");
  });
});

describe("Windows 布局", () => {
  const CODEX_WIN = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
  it("npm 的 .cmd 包装背后是 node_modules 里的脚本：认得是 npm 装的，前缀没有 lib", () => {
    expect(installMethodOf("codex", CODEX_WIN)).toBe("npm-global");
    expect(npmPrefixOf(CODEX_WIN)).toBe("C:/Users/me/AppData/Roaming/npm");
    expect(installMethodOf("dsh", "D:\\Tools\\DSH\\apps\\cli\\lib\\bin.js")).toBe("git-checkout");
  });
  it("跑的是哪个文件：Node 下的脚本，或者程序本身", () => {
    expect(programOf({ file: "C:\\node\\node.exe", prefixArgs: [CODEX_WIN] })).toBe(CODEX_WIN);
    expect(programOf({ file: "C:\\x\\claude.exe", prefixArgs: [] })).toBe("C:\\x\\claude.exe");
  });
});
