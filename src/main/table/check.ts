/**
 * check.ts — running a phase's exit check, in the project folder.
 *
 * 移植自 Squad 2.x packages/table/src/service.ts 的 runCheck @ 8dcb903，
 * 以及 packages/table/src/check-shell.ts @ 8e96d9c
 * 改动：2.x 经 dsh 的 subprocess 服务跑；3 用 seat-runtime 的 startChild（取消时清整棵进程树）。
 * 跟 2.x 一样用本机自带的 shell：Windows 上是 PowerShell，macOS/Linux 上是 /bin/sh——
 * 秘书起草时被告知是哪一种（secretary/agenda.ts）。阶段 4a 曾在 Windows 上找 Git 自带的 bash，
 * 2.x 8e96d9c 改成原生 shell 之后跟着改：不再依赖装没装 Git。
 *
 * By Squad, not by a seat: a seat asked whether its own work passed is the one
 * party with a reason to say yes. Never throws — a check that cannot be
 * started has not passed, and says why in the place its output would be.
 */
import type { ExitCheckResult } from "../../shared/index.ts";
import { startChild } from "../seat-runtime/index.ts";

/** Default limit for one check, and how much of its output is collected and kept. */
export const CHECK_TIMEOUT_SEC = 600;
const CHECK_OUTPUT_CHARS = 256 * 1024;
const CHECK_TAIL_CHARS = 2000;

/** Run agenda checks in the host platform's native shell. */
export function checkShellArgv(command: string, platform: string = process.platform): readonly string[] {
  return platform === "win32"
    ? ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
    : ["/bin/sh", "-c", command];
}

export async function runExitCheck(
  check: { readonly command: string; readonly timeoutSec?: number | undefined },
  cwd: string,
  stop: AbortSignal,
  platform: string = process.platform,
): Promise<ExitCheckResult> {
  if (stop.aborted) return { exitCode: null, tail: "议程已停，检查没有运行。", at: Date.now() };
  const [file, ...args] = checkShellArgv(check.command, platform);
  const child = startChild({
    command: { file: file ?? "", prefixArgs: [] },
    args,
    cwd,
    env: process.env,
    stdin: "",
    maxStdout: CHECK_OUTPUT_CHARS,
    maxStderr: CHECK_OUTPUT_CHARS,
  });
  let timedOut = false;
  const onStop = (): void => child.terminate();
  stop.addEventListener("abort", onStop, { once: true });
  const timer = setTimeout(
    () => {
      timedOut = true;
      child.terminate();
    },
    (check.timeoutSec ?? CHECK_TIMEOUT_SEC) * 1000,
  );
  try {
    const outcome = await child.done;
    if (outcome.spawnError !== undefined) {
      return { exitCode: null, tail: `检查没能运行：${outcome.spawnError}`, at: Date.now() };
    }
    const out = child.stdout.value;
    const err = child.stderr.value;
    return {
      exitCode: timedOut ? null : outcome.exitCode,
      tail: `${out}${err === "" ? "" : `\n${err}`}`.trim().slice(-CHECK_TAIL_CHARS),
      at: Date.now(),
      ...(timedOut ? { timedOut: true } : {}),
    };
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", onStop);
  }
}
