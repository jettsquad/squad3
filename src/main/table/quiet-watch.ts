/**
 * quiet-watch.ts — a quiet command, taken to somebody who can judge it.
 *
 * 移植自 Squad 2.x packages/console/src/quiet-watch.ts @ 8e96d9c
 * 改动：2.x 在 console 里经 dsh 的事件找回团队；3 的桌子自己就握着团队和席位，
 * 判断函数（秘书）由组装处传进来——桌子不认识秘书模块。
 *
 * The runtime notices that a seat has written nothing for a whole window
 * while a command it started is still open, and that is all it can know.
 * Whether to keep waiting is a judgement, and judgement is the secretary's.
 *
 * Whatever happens, the seat gets a verdict. No secretary, the secretary
 * being the quiet seat, the secretary failing to answer — each of those ends
 * in `ask`, with the reason, because a command nobody managed to judge is one
 * the host should be shown rather than one to go on waiting for in silence.
 */
import { open } from "node:fs/promises";
import type { OpenCommand } from "../seat-runtime/index.ts";

/** What the secretary is shown — the same shape `secretary/quiet.ts` builds its prompt from. */
export interface QuietJudgementInput {
  readonly seat: string;
  readonly task?: string | undefined;
  readonly commands: readonly {
    readonly command: string;
    readonly runningForMs: number;
    readonly background: boolean;
    readonly outputTail?: string | undefined;
  }[];
  readonly quietForMs: number;
  readonly lastWords?: string | undefined;
}

export interface QuietJudgement {
  readonly verdict: "wait" | "ask";
  readonly reason: string;
}

export interface QuietVerdict extends QuietJudgement {
  readonly at: number;
  readonly by: "secretary" | "system";
}

/**
 * How much of a command's own output to read for the secretary. The prompt
 * cuts to its own limit; this only bounds what is read off disk.
 */
const TAIL_CHARS = 2000;

/**
 * How long the secretary gets to say whether to wait.
 *
 * Two lines from a model that was told not to use tools: observed at about
 * thirteen seconds. Long enough for a slow one, short against the window it
 * is judging.
 */
export const JUDGEMENT_TIMEOUT_MS = 90_000;

/**
 * The end of a file, or nothing.
 *
 * Read from the end and bounded: a command's output can be gigabytes, and
 * only its last screen says whether it is still getting anywhere.
 */
export async function tailOf(path: string, chars = TAIL_CHARS): Promise<string | undefined> {
  try {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      // Bytes, not characters: four per character is the most UTF-8 takes, so
      // this never reads less than was asked for.
      const length = Math.min(size, chars * 4);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      return buffer.toString("utf8").slice(-chars);
    } finally {
      await file.close();
    }
  } catch {
    // Gone, unreadable, or never written. The judgement goes ahead without it.
    return undefined;
  }
}

/** What to record when the secretary could not be asked. */
export function unjudged(why: string, at = Date.now()): QuietVerdict {
  return { verdict: "ask", reason: why, at, by: "system" };
}

/**
 * Get a verdict for one quiet command. Never throws.
 *
 * `judge` is undefined when the team has nobody to ask (no secretary, or the
 * secretary is the quiet seat) — `nobody` says which.
 */
export async function judgeQuiet(input: {
  readonly seat: string;
  readonly task?: string | undefined;
  readonly open: readonly OpenCommand[];
  readonly quietForMs: number;
  readonly lastWords?: string | undefined;
  readonly judge: ((input: QuietJudgementInput, signal: AbortSignal) => Promise<QuietJudgement>) | undefined;
  readonly nobody: string;
  readonly timeoutMs?: number | undefined;
  readonly now?: number | undefined;
}): Promise<QuietVerdict> {
  if (input.judge === undefined) return unjudged(input.nobody);
  const now = input.now ?? Date.now();
  const commands = await Promise.all(
    input.open.map(async (one) => ({
      command: one.command,
      runningForMs: now - one.startedAt,
      background: one.background,
      outputTail: one.outputFile === undefined ? undefined : await tailOf(one.outputFile),
    })),
  );
  // The secretary is a model, and a model can fail to answer for the same
  // reasons a seat can. A judgement that never comes back is the worst
  // outcome there is — the command goes unjudged AND looks judged — so it is
  // given a bounded time and then the host is shown the command.
  const timeoutMs = input.timeoutMs ?? JUDGEMENT_TIMEOUT_MS;
  const patience = new AbortController();
  const timer = setTimeout(() => patience.abort(new Error("timeout")), timeoutMs);
  try {
    const judged = await Promise.race([
      input.judge(
        {
          seat: input.seat,
          ...(input.task === undefined ? {} : { task: input.task }),
          commands,
          quietForMs: input.quietForMs,
          ...(input.lastWords === undefined ? {} : { lastWords: input.lastWords }),
        },
        patience.signal,
      ),
      new Promise<never>((_, reject) => {
        patience.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
      }),
    ]);
    return { ...judged, at: Date.now(), by: "secretary" };
  } catch (failure) {
    if (patience.signal.aborted) {
      return unjudged(`秘书 ${Math.round(timeoutMs / 1000)} 秒内没有给出判断，所以直接请你看。`);
    }
    const message = failure instanceof Error ? failure.message : String(failure);
    return unjudged(`秘书没能给出判断（${message.slice(0, 120)}），所以直接请你看。`);
  } finally {
    clearTimeout(timer);
  }
}

/** The line the record carries for a judged quiet command. */
export function quietLine(seat: string, quietForMs: number, command: string, verdict: QuietVerdict): string {
  return (
    `${seat} 的命令安静了 ${Math.round(quietForMs / 60_000)} 分钟（${command}）。` +
    `${verdict.by === "secretary" ? "秘书" : "系统"}判断：${verdict.verdict === "wait" ? "继续等" : "请主持人看"}——${verdict.reason}`
  );
}
