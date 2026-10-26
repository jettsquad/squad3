/**
 * run.ts — running one CLI seat, once, for any backend.
 *
 * 移植自 Squad 2.x packages/seat-runtime/src/index.ts 的 `runCliSeat` @ 8dcb903
 * 改动：不再借 dsh 的 `subprocessRunHandle` / `settleRunResult`；同一条契约在这里自己守：
 * `result` 发布之后绝不 reject，失败一律 resolve 成 `failed: true` 并带上原因。
 * 子进程由 `process.ts` 管（stdin 传 prompt、按尾部截断、整树清理）。
 * 「正在做什么」的命令追踪（2.x 的 tracker / activity）阶段 2 随席位状态一起搬。
 *
 * The three backends differ only in which executable they run, which
 * arguments they build, and how they read the output back. The parts they
 * DON'T differ in are the parts easy to get subtly wrong and hard to notice:
 * the run contract, cancellation reaching the child, the silence watchdog,
 * and reading collected output once after exit. Three copies would drift.
 */
import { statSync } from "node:fs";
import type { SeatUsage } from "../../shared/seat-usage.ts";
import { withoutHeartbeats } from "./alive.ts";
import type { ResolvedCommand } from "./command.ts";
import { failureText } from "./failure.ts";
import { startChild, type RunningChild } from "./process.ts";
import { silenceMessage, watchSilence, type SilenceLimits } from "./silence.ts";
import type { OpenCommand, StreamTracker } from "./tracker.ts";

/** What a backend's parser makes of one run's output. */
export interface SeatOutcome {
  readonly text: string;
  readonly failed: boolean;
  /** What the backend's own parser knows about the failure, when it knows anything. */
  readonly detail?: string | undefined;
  readonly usage?: SeatUsage | undefined;
  /** The CLI's own id for this conversation, when the backend reports one. */
  readonly sessionId?: string | undefined;
}

/** What one turn produced. */
export interface SeatResult {
  /**
   * The answer, or — when there is none — why not. Never empty on failure,
   * except a cancelled run, which carries only what the seat had said (maybe nothing).
   */
  readonly text: string;
  readonly failed: boolean;
  /** The person pressed stop. Always with `failed`: a stopped turn is not an answer. */
  readonly cancelled: boolean;
  readonly usage?: SeatUsage | undefined;
  readonly sessionId?: string | undefined;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

/** Live progress, for the 「正在做什么」 line and the status dot. */
export interface SeatActivity {
  /** Characters of output so far, both streams. */
  readonly received: number;
  /** What the seat's own stream says it started and has not finished. Empty without a tracker. */
  readonly open: readonly OpenCommand[];
  /** The last thing it said in words, while it works. */
  readonly lastWords?: string | undefined;
  /**
   * Set when a full silence window passed with a command still open: the seat
   * was left running, not cancelled, and someone should be told (2.x §quiet).
   */
  readonly quietForMs?: number | undefined;
}

export interface SeatRun {
  /** Settles once. Never rejects: a failing seat is a result, not an exception. */
  readonly result: Promise<SeatResult>;
  /** Stop this turn. The result then settles with `cancelled: true`. */
  cancel(): void;
}

export interface CliSeatSpec {
  /** For messages that must say who refused. */
  readonly who: string;
  readonly command: ResolvedCommand;
  readonly args: readonly string[];
  /** The prompt, written to stdin. */
  readonly stdin: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly parse: (stdout: string, stderr: string) => SeatOutcome;
  readonly limits: SilenceLimits;
  readonly signal?: AbortSignal | undefined;
  readonly onActivity?: ((activity: SeatActivity) => void) | undefined;
  /**
   * How to read this backend's output while it runs. With one, a quiet seat
   * whose stream says a command is still running is left alone and reported,
   * rather than cancelled as wedged — the full test suite 2.x killed twice.
   */
  readonly tracker?: (() => StreamTracker) | undefined;
  /** Run after the child settles, whatever happened. */
  readonly cleanup?: (() => Promise<void>) | undefined;
}

/** The last few lines a CLI wrote to stderr. */
function stderrTail(text: string, lines = 8): string {
  // Heartbeats dropped BEFORE the tail is taken: they share this stream, and a
  // long run emits enough of them to push the line that explains the failure
  // out of the window entirely.
  const trimmed = withoutHeartbeats(text).trim();
  return trimmed === "" ? "" : trimmed.split("\n").slice(-lines).join("\n");
}

/** A run that never started, settled with the reason. A missing CLI is a seat that failed and says why. */
export function refusedRun(text: string): SeatRun {
  return {
    result: Promise.resolve({ text, failed: true, cancelled: false, exitCode: null, durationMs: 0 }),
    cancel: () => undefined,
  };
}

/**
 * A run whose child can only start after some async preparation (a patch
 * file, a skills folder). The handle exists at once; a cancel that arrives
 * before the child does is held and delivered when it starts; a failed
 * preparation settles as a failed seat that says what broke.
 */
export function deferredRun(who: string, prepare: () => Promise<SeatRun>): SeatRun {
  let inner: SeatRun | undefined;
  let cancelled = false;
  const result = (async (): Promise<SeatResult> => {
    inner = await prepare();
    if (cancelled) inner.cancel();
    return inner.result;
  })().catch((error: unknown): SeatResult => ({
    text: `⚠️ ${who} 席位没能启动：${error instanceof Error ? error.message : String(error)}`,
    failed: true,
    cancelled: false,
    exitCode: null,
    durationMs: 0,
  }));
  return {
    result,
    cancel: () => {
      cancelled = true;
      inner?.cancel();
    },
  };
}

function failed(text: string, startedAt: number, exitCode: number | null = null): SeatResult {
  return { text, failed: true, cancelled: false, exitCode, durationMs: Date.now() - startedAt };
}

/**
 * Check the folder before starting anything. A seat started in a folder that
 * does not exist fails with a spawn error that names the executable, not the
 * folder — the person then looks in the wrong place.
 */
function cwdProblem(cwd: string): string | undefined {
  try {
    return statSync(cwd).isDirectory() ? undefined : `项目文件夹「${cwd}」不是一个目录。`;
  } catch {
    return `项目文件夹「${cwd}」不存在。`;
  }
}

export function runCliSeat(spec: CliSeatSpec): SeatRun {
  const startedAt = Date.now();
  let cancelled = false;
  let child: RunningChild | undefined;

  const cancel = (): void => {
    cancelled = true;
    child?.terminate();
  };
  if (spec.signal?.aborted === true) cancelled = true;
  spec.signal?.addEventListener("abort", cancel, { once: true });

  const attempt = async (): Promise<SeatResult> => {
    const problem = cwdProblem(spec.cwd);
    if (problem !== undefined) return failed(`⚠️ ${spec.who}：${problem}`, startedAt);
    if (spec.stdin.trim() === "") return failed(`⚠️ ${spec.who}：席位任务不能是空的。`, startedAt);
    if (cancelled) return { ...failed("", startedAt), cancelled: true };

    child = startChild({ command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, stdin: spec.stdin });
    const running = child;
    const tracker = spec.tracker?.();
    if (tracker !== undefined) running.onStdout((chunk) => tracker.feed(chunk));
    const activity = (quietForMs?: number): SeatActivity => ({
      // BOTH streams: a backend that cannot stream its answer says it is
      // alive on stderr instead, and counting only stdout once had a healthy
      // seat cancelled for producing no output.
      received: running.stdout.received + running.stderr.received,
      open: tracker?.open() ?? [],
      ...(tracker?.lastWords() === undefined ? {} : { lastWords: tracker.lastWords() }),
      ...(quietForMs === undefined ? {} : { quietForMs }),
    });
    let silence: "silent" | "no-output" | undefined;
    const watch = watchSilence(
      async () => {
        // The same number the watchdog judges on, so the display cannot
        // disagree with the decision it is supposed to explain.
        const now = activity();
        spec.onActivity?.(now);
        return now.received;
      },
      spec.limits,
      (reason) => {
        silence = reason;
        running.terminate();
      },
      tracker === undefined
        ? undefined
        : {
            running: () => tracker.open().length > 0,
            onQuiet: (quietForMs) => spec.onActivity?.(activity(quietForMs)),
          },
    );
    try {
      const exit = await running.done;
      if (exit.spawnError !== undefined) {
        return failed(`⚠️ ${spec.who}：没能启动「${spec.command.file}」：${exit.spawnError}`, startedAt);
      }
      const parsed = spec.parse(running.stdout.value, running.stderr.value);
      const durationMs = Date.now() - startedAt;
      const base = {
        exitCode: exit.exitCode,
        durationMs,
        ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
        ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
      };
      if (cancelled) {
        // What the seat had said so far, as it said it. Marking it as cut
        // short — or saying it said nothing — is the table's job, because the
        // table also writes the system line that names who pressed stop.
        return { ...base, text: parsed.text.trim(), failed: true, cancelled: true };
      }
      // A non-zero exit with text still carries the text: a failure that
      // explains itself is worth more than one that does not.
      const isFailure = parsed.failed || exit.exitCode !== 0;
      const text =
        silence !== undefined
          ? silenceMessage(silence, spec.limits)
          : isFailure && parsed.text.trim() === ""
            ? failureText({ detail: parsed.detail, stderr: stderrTail(running.stderr.value), exitCode: exit.exitCode })
            : parsed.text;
      return { ...base, text, failed: isFailure || silence !== undefined, cancelled: false };
    } finally {
      watch.stop();
      spec.signal?.removeEventListener("abort", cancel);
      await spec.cleanup?.().catch(() => undefined);
    }
  };

  // The contract: settle, never reject. Anything thrown above is our bug, and
  // it still arrives as a failed seat that says what went wrong — not as a
  // round that hangs on a promise nobody resolves.
  const result = attempt().catch((error: unknown) =>
    failed(`⚠️ ${spec.who}：运行席位时出错：${error instanceof Error ? error.message : String(error)}`, startedAt),
  );
  return { result, cancel };
}
