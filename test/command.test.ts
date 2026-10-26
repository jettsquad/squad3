/**
 * Resolving `claude` / `codex` on Windows means reading npm's `.cmd` wrappers.
 * The two shapes here are copied from the real files on the dev machine
 * (2026-10-20), not invented.
 */
import { describe, expect, it } from "vitest";
import {
  CommandNotFoundError,
  plainWrapperTarget,
  resolveCommand,
  shimTarget,
  type CommandHost,
} from "../src/main/seat-runtime/command.ts";

const CLAUDE_CMD = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

const CODEX_CMD = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

function host(files: Record<string, string>, extra: Partial<CommandHost> = {}): CommandHost {
  const lower = new Map(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    platform: "win32",
    env: { PATH: "C:\\nodejs;H:\\cli", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    exists: (path) => lower.has(path.toLowerCase()),
    readText: (path) => lower.get(path.toLowerCase()) ?? "",
    execPath: "C:\\Squad\\Squad.exe",
    ...extra,
  };
}

describe("shimTarget", () => {
  it("finds the exe behind claude's wrapper", () => {
    expect(shimTarget("H:\\cli\\claude.cmd", CLAUDE_CMD)).toBe(
      "H:\\cli\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    );
  });

  it("finds the script behind codex's wrapper, not its optional node.exe", () => {
    expect(shimTarget("H:\\cli\\codex.cmd", CODEX_CMD)).toBe("H:\\cli\\node_modules\\@openai\\codex\\bin\\codex.js");
  });

  it("says nothing for a file that is not an npm wrapper", () => {
    expect(shimTarget("H:\\cli\\x.cmd", "@echo hello")).toBeUndefined();
  });
});

describe("resolveCommand on Windows", () => {
  it("runs claude's exe directly, with no shell in between", () => {
    const resolved = resolveCommand(
      "claude",
      host({
        "H:\\cli\\claude.cmd": CLAUDE_CMD,
        "H:\\cli\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe": "",
      }),
    );
    expect(resolved).toEqual({
      file: "H:\\cli\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
      prefixArgs: [],
    });
  });

  it("runs codex's script under the node on PATH", () => {
    const resolved = resolveCommand(
      "codex",
      host({
        "C:\\nodejs\\node.exe": "",
        "H:\\cli\\codex.cmd": CODEX_CMD,
        "H:\\cli\\node_modules\\@openai\\codex\\bin\\codex.js": "",
      }),
    );
    expect(resolved).toEqual({
      file: "C:\\nodejs\\node.exe",
      prefixArgs: ["H:\\cli\\node_modules\\@openai\\codex\\bin\\codex.js"],
    });
  });

  it("falls back to running Electron as Node when there is no node on PATH", () => {
    const resolved = resolveCommand(
      "codex",
      host({ "H:\\cli\\codex.cmd": CODEX_CMD, "H:\\cli\\node_modules\\@openai\\codex\\bin\\codex.js": "" }),
    );
    expect(resolved.file).toBe("C:\\Squad\\Squad.exe");
    expect(resolved.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("prefers an .exe over a .cmd in the same folder, following PATHEXT order", () => {
    const resolved = resolveCommand("tool", host({ "H:\\cli\\tool.exe": "", "H:\\cli\\tool.cmd": CLAUDE_CMD }));
    expect(resolved.file).toBe("H:\\cli\\tool.exe");
  });

  it("names the command when it is not on PATH", () => {
    expect(() => resolveCommand("claude", host({}))).toThrow(CommandNotFoundError);
    expect(() => resolveCommand("claude", host({}))).toThrow(/claude/);
  });

  // The shape of the dsh wrapper on the dev machine (2026-10-23): dsh run from a checkout.
  const DSH_CMD = '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "D:\\Tools\\DSH\\apps\\cli\\lib\\bin.js" %*\r\n';

  it("runs a hand-written one-line wrapper's program and script directly", () => {
    const resolved = resolveCommand(
      "dsh",
      host({
        "H:\\cli\\dsh.cmd": DSH_CMD,
        "C:\\Program Files\\nodejs\\node.exe": "",
        "D:\\Tools\\DSH\\apps\\cli\\lib\\bin.js": "",
      }),
    );
    expect(resolved).toEqual({
      file: "C:\\Program Files\\nodejs\\node.exe",
      prefixArgs: ["D:\\Tools\\DSH\\apps\\cli\\lib\\bin.js"],
    });
  });

  it("reads a one-line wrapper only when it passes everything on and names absolute paths", () => {
    expect(plainWrapperTarget('"C:\\a\\tool.exe" %*')).toEqual({ program: "C:\\a\\tool.exe" });
    expect(plainWrapperTarget('@echo off\nrem x\n"C:\\n\\node.exe" "C:\\s\\b.js" %*')).toEqual({
      program: "C:\\n\\node.exe",
      script: "C:\\s\\b.js",
    });
    // Arguments of its own, no %*, variables, two commands: not read.
    expect(plainWrapperTarget('"C:\\a\\tool.exe" --fast %*')).toBeUndefined();
    expect(plainWrapperTarget('"C:\\a\\tool.exe"')).toBeUndefined();
    expect(plainWrapperTarget('"%~dp0\\tool.exe" %*')).toBeUndefined();
    expect(plainWrapperTarget('"C:\\a\\tool.exe" %*\n"C:\\b\\other.exe" %*')).toBeUndefined();
    expect(plainWrapperTarget('node "C:\\s\\b.js" %*')).toBeUndefined();
  });

  it("refuses a one-line wrapper whose program is missing", () => {
    expect(() => resolveCommand("dsh", host({ "H:\\cli\\dsh.cmd": DSH_CMD }))).toThrow(/找不到它真正要运行的程序/);
  });

  it("refuses a wrapper whose target is missing instead of running something else", () => {
    expect(() => resolveCommand("claude", host({ "H:\\cli\\claude.cmd": CLAUDE_CMD }))).toThrow(
      /找不到它真正要运行的程序/,
    );
  });
});
