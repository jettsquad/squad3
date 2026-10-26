/**
 * process.ts — one child process for one seat turn.
 *
 * New in Squad 3; replaces dsh's `ctx.subprocess`, which 2.x borrowed. What it
 * has to get right, each learned somewhere:
 *
 * - **The prompt goes on stdin, not argv.** Windows caps a command line at
 *   32,767 characters; a seat prompt carries the whole discussion and passes
 *   that within a few long rounds. 2.x put it in argv, which macOS tolerates
 *   up to about a megabyte. Verified 2026-10-20: `claude -p` with no prompt
 *   argument reads it from stdin, Chinese intact.
 * - **Output is collected with a cap that keeps the TAIL.** A seat's stdout is
 *   read once, after it exits, and an unbounded buffer would let a chatty run
 *   take the app down with it. The answer is at the end, so that is what stays.
 * - **Cancelling kills the whole tree.** A CLI agent runs tools, and a tool
 *   runs processes. Killing only the CLI leaves its test runner or build going
 *   in the project folder, holding files, after the person pressed 叫停.
 *   Windows: `taskkill /T /F`. Elsewhere: the child leads its own process
 *   group and the group is signalled.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { ResolvedCommand } from "./command.ts";

/** Keeps the last `max` characters of a stream, and says whether it lost any. */
export class TailBuffer {
  private text = "";
  private total = 0;
  private dropped = false;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  append(chunk: string): void {
    this.total += chunk.length;
    this.text += chunk;
    if (this.text.length > this.max) {
      this.text = this.text.slice(this.text.length - this.max);
      this.dropped = true;
    }
  }

  /** Everything kept. */
  get value(): string {
    return this.text;
  }

  /** Characters ever received, kept or not. The watchdog judges on this. */
  get received(): number {
    return this.total;
  }

  /** Whether the head was cut off to stay under the cap. */
  get lossy(): boolean {
    return this.dropped;
  }
}

export interface ChildSpec {
  readonly command: ResolvedCommand;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Written to stdin, then stdin is closed. */
  readonly stdin: string;
  readonly maxStdout?: number;
  readonly maxStderr?: number;
}

export interface ChildExit {
  /** Null when a signal ended it. Comparing against 0 alone would read a killed seat as a clean one. */
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface RunningChild {
  readonly pid: number | undefined;
  readonly stdout: TailBuffer;
  readonly stderr: TailBuffer;
  /** Called with each piece of stdout as it arrives. */
  onStdout(listener: (chunk: string) => void): void;
  /** Settles when the process has exited and both streams are closed. Never rejects. */
  readonly done: Promise<ChildExit & { readonly spawnError?: string | undefined }>;
  /** Kill the process and everything it started. Safe to call more than once. */
  terminate(): void;
}

const DEFAULT_MAX_STDOUT = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 256 * 1024;

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // Detached and unwaited: taskkill's own exit says nothing we act on, and
    // `done` reports what actually happened to the child.
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const hard = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 5_000);
  hard.unref();
  child.once("exit", () => clearTimeout(hard));
}

export function startChild(spec: ChildSpec): RunningChild {
  const stdout = new TailBuffer(spec.maxStdout ?? DEFAULT_MAX_STDOUT);
  const stderr = new TailBuffer(spec.maxStderr ?? DEFAULT_MAX_STDERR);
  const listeners: ((chunk: string) => void)[] = [];

  const child = spawn(spec.command.file, [...spec.command.prefixArgs, ...spec.args], {
    cwd: spec.cwd,
    env: { ...spec.env, ...spec.command.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Its own process group, so the group can be signalled as one. On Windows
    // `detached` would open a console window instead; taskkill /T walks the
    // tree there.
    detached: process.platform !== "win32",
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout.append(chunk);
    for (const listener of listeners) listener(chunk);
  });
  child.stderr?.on("data", (chunk: string) => stderr.append(chunk));

  const done = new Promise<ChildExit & { readonly spawnError?: string | undefined }>((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      // Spawn failed outright (missing file, bad cwd). There is no exit event
      // after this, so it settles here — with the reason, not a bare failure.
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, signal: null, spawnError: error.message });
    });
    // `close`, not `exit`: close waits for the streams to drain, so the last
    // chunk of the answer is in the buffer when the caller reads it.
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code, signal });
    });
  });

  // A child that exits without reading stdin makes the write fail with EPIPE.
  // That is the child's business and `done` reports it; it must not crash us.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(spec.stdin, "utf8");

  let terminated = false;
  return {
    pid: child.pid,
    stdout,
    stderr,
    onStdout: (listener) => listeners.push(listener),
    done,
    terminate: () => {
      if (terminated) return;
      terminated = true;
      killTree(child);
    },
  };
}
