/**
 * Exit checks run in the host's own shell, in the project folder; exit code 0
 * passes; a timeout or a stop never reads as a pass.
 *
 * The first block is 移植自 Squad 2.x packages/table/test/check-shell.test.ts @ 8e96d9c.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkShellArgv, runExitCheck } from "../src/main/table/check.ts";

describe("agenda check shell", () => {
  it("uses the host shell on Windows and POSIX", () => {
    expect(checkShellArgv("exit 1", "win32")).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "exit 1",
    ]);
    expect(checkShellArgv("exit 1", "darwin")).toEqual(["/bin/sh", "-c", "exit 1"]);
  });

  it.skipIf(process.platform !== "win32")(
    "runs the secretary's conditional check and rejects missing or short files",
    () => {
      const root = mkdtempSync(join(tmpdir(), "squad-check-"));
      const command =
        "if (-not (Test-Path 'plan.md')) { exit 1 }; $c = Get-Content 'plan.md' -Raw; if ($c.Length -lt 20) { exit 1 }; exit 0";
      const [program, ...args] = checkShellArgv(command, "win32");
      if (program === undefined) throw new Error("No shell");
      try {
        expect(spawnSync(program, args, { cwd: root }).status).toBe(1);
        writeFileSync(join(root, "plan.md"), "stub");
        expect(spawnSync(program, args, { cwd: root }).status).toBe(1);
        writeFileSync(join(root, "plan.md"), "A complete document that exceeds the required size.");
        expect(() => execFileSync(program, args, { cwd: root })).not.toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    // Three cold PowerShell starts: about three seconds each here.
    60_000,
  );
});

// ── 3: through the runner (startChild, which clears the whole process tree) ──

const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "squad-check-"));
  writeFileSync(join(dir, "done.md"), "ok\n");
  return dir;
};
const never = new AbortController().signal;
const windows = process.platform === "win32";

/** The same three checks, written for the shell this machine runs them in. */
const commands = windows
  ? {
      found: "if (-not (Test-Path 'done.md')) { exit 1 }; Write-Output found",
      failing: "[Console]::Error.WriteLine('nope'); exit 3",
      slow: "Start-Sleep -Seconds 5",
    }
  : { found: "test -f done.md && echo found", failing: "echo nope >&2; exit 3", slow: "sleep 5" };

describe("runExitCheck", () => {
  it("passes on exit 0, in the project folder", async () => {
    const result = await runExitCheck({ command: commands.found }, folder(), never);
    expect(result.exitCode).toBe(0);
    expect(result.tail).toBe("found");
  });

  it("fails with the exit code and keeps stderr", async () => {
    const result = await runExitCheck({ command: commands.failing }, folder(), never);
    expect(result.exitCode).toBe(3);
    expect(result.tail).toContain("nope");
  });

  it("a timeout is not a pass", async () => {
    const result = await runExitCheck({ command: commands.slow, timeoutSec: 1 }, folder(), never);
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
  });

  it("a stopped agenda does not run its check", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const result = await runExitCheck({ command: commands.found }, folder(), stopped.signal);
    expect(result.exitCode).toBeNull();
    expect(result.tail).toMatch(/没有运行/);
  });
});
