/**
 * silence.ts — deciding that a seat has stopped talking.
 *
 * 移植自 Squad 2.x packages/seat-runtime/src/silence.ts @ 8dcb903（无改动）
 *
 * Its own module because it is the judgement the first watchdog got wrong:
 * it had ONE deadline where there are two, and it counted from the start
 * where it must count from the last byte. The comment claimed "idle rather
 * than total" while the code armed a single timer and never reset it, so a
 * long task died mid-answer and an unreachable endpoint took ten minutes to
 * say nothing.
 */

export interface SilenceLimits {
  /** How long a seat may go quiet AFTER it has said something. */
  readonly idleMs: number;
  /** How long a seat may say nothing at all before it counts as unreachable. */
  readonly firstOutputMs: number;
  /** How often to look. */
  readonly pollMs: number;
}

export type SilenceReason = "silent" | "no-output";

/**
 * The thresholds every seat backend uses, in ONE place.
 *
 * `idleMs` is fifteen minutes of SILENCE, not of work. There is no
 * total-duration cap, and there should not be — a deep task legitimately runs
 * far longer than any wall clock, and a CLI that is working streams as it
 * goes, so it never goes quiet for long.
 *
 * `firstOutputMs`: before the first byte there is nothing to be deep ABOUT.
 * Five minutes, from a measurement: a dsh seat on a real round took about 100
 * seconds to produce its first byte. A deadline that close to observed
 * behaviour will eventually fire on a healthy seat, and a watchdog that cries
 * wolf gets ignored on the day it is right.
 */
export const SEAT_SILENCE_LIMITS: SilenceLimits = {
  idleMs: 900_000,
  firstOutputMs: 300_000,
  pollMs: 2_000,
};

/**
 * Whether a stretch of silence has become a verdict, and which one.
 *
 * @param bytesSeen - total output bytes so far; zero means nothing ever arrived.
 * @param quietFor - milliseconds since the byte count last changed.
 */
export function silenceVerdict(
  bytesSeen: number,
  quietFor: number,
  limits: Pick<SilenceLimits, "idleMs" | "firstOutputMs">,
): SilenceReason | undefined {
  // Before the first byte the shorter deadline applies — and the verdict names
  // the difference, because "never answered" and "stopped answering" send a
  // person to different places.
  if (bytesSeen === 0) return quietFor >= limits.firstOutputMs ? "no-output" : undefined;
  return quietFor >= limits.idleMs ? "silent" : undefined;
}

/**
 * What lets a quiet seat keep running: its stream says a command is open.
 *
 * Only ever consulted for `silent`. A seat that has not produced a byte has
 * not started a command either, so `no-output` is never excused by this.
 */
export interface SilenceBusy {
  /** Whether the seat's own output says something it started is unfinished. */
  readonly running: () => boolean;
  /** Called each time a full window passes in silence with a command open. */
  readonly onQuiet: (quietForMs: number) => void;
}

/**
 * Cancel a seat that has gone silent — not one that is merely slow.
 *
 * Watches the stream: bytes arriving reset the clock, silence does not.
 */
export function watchSilence(
  read: () => Promise<number>,
  limits: SilenceLimits,
  onVerdict: (reason: SilenceReason) => void,
  busy?: SilenceBusy,
): { stop(): void } {
  let seen = 0;
  let lastChange = Date.now();
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const bytes = await read().catch(() => seen);
    if (bytes > seen) {
      seen = bytes;
      lastChange = Date.now();
    }
    const quietFor = Date.now() - lastChange;
    const verdict = silenceVerdict(seen, quietFor, limits);
    // Quiet, but its own output says a command is still running: that is a
    // seat waiting, not a seat gone. The window starts over and somebody is
    // told, once per window.
    if (verdict === "silent" && busy?.running() === true) {
      lastChange = Date.now();
      busy.onQuiet(quietFor);
    } else if (verdict !== undefined) {
      stopped = true;
      onVerdict(verdict);
      return;
    }
    const next = setTimeout(() => void tick(), limits.pollMs);
    next.unref?.();
  };

  const first = setTimeout(() => void tick(), limits.pollMs);
  first.unref?.();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

/** What a watchdog kill should say, so the reason reaches the person. */
export function silenceMessage(reason: SilenceReason, limits: Pick<SilenceLimits, "idleMs" | "firstOutputMs">): string {
  return reason === "no-output"
    ? `这个席位 ${Math.round(limits.firstOutputMs / 60_000)} 分钟内一个字都没输出，按连不上处理。` +
        `多半是它的连接端点没有响应——到 Agent 库点「测试」看接口地址那一项。`
    : `这个席位连续 ${Math.round(limits.idleMs / 60_000)} 分钟没有任何新输出，判定为卡死，已经中止。` +
        `判据是静默：只要有输出（哪怕是思考过程）就重新计时；它自己的输出显示有命令还没跑完时，也不会被中止。`;
}
