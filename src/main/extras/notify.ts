/**
 * notify.ts — what a finished round is worth saying, outside the window.
 *
 * 移植自 Squad 2.x packages/console/src/notify.ts @ 8e96d9c
 * 改动：只留「说什么」（bannerFor、previewOf）。「怎么弹」换成 Electron 的 Notification，
 * 三个平台都有（2.x 只有 macOS 的 osascript 和 Linux 的 notify-send，Windows 上什么都没有），
 * 所以 appleScriptString 不要了；「人在不在看」由主进程直接问窗口有没有焦点，
 * 不再靠页面每十秒报一次（PresenceTracker 不要了）。多一种：安静的命令请主持人看。
 *
 * Skipped while the window is in front of the person: being told what you
 * are reading is noise, and noise is what gets a notification switched off.
 */

/** What a finished round is worth saying, structurally the same as the table's event. */
export interface FinishedRound {
  readonly teamName: string;
  readonly kind: "round" | "agenda";
  readonly stopped: boolean;
  readonly answered: number;
  readonly failed: number;
  readonly last?: { readonly speaker: string; readonly text: string } | undefined;
  readonly moreQueued: boolean;
  readonly waitingForHost: boolean;
}

export interface Banner {
  readonly title: string;
  readonly body: string;
}

const PREVIEW_CHARS = 90;

/** One line of a reply, with Markdown noise flattened so a banner is readable. */
export function previewOf(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS)}…`;
}

/** The banner for a finished round, or undefined when this is not a moment to interrupt. */
export function bannerFor(round: FinishedRound): Banner | undefined {
  // A queued message is already starting the next round: the person asked for
  // both, and one banner when the last of them ends is what they want.
  if (round.moreQueued) return undefined;
  const title = round.teamName;
  const what = round.kind === "agenda" ? "议程" : "这一轮";
  if (round.waitingForHost) return { title, body: `${what}停在这里，等你来决定下一步。` };
  if (round.stopped) return { title, body: `${what}已被叫停。` };
  if (round.answered > 0 && round.failed === round.answered) {
    return { title, body: `${what}结束了，但席位都没答上来。` };
  }
  const failure = round.failed > 0 ? `（${round.failed} 位没答上）` : "";
  const preview = round.last === undefined ? "" : ` ${round.last.speaker}：${previewOf(round.last.text)}`;
  return { title, body: `${what}完成了${failure}。${preview}`.trimEnd() };
}

/** A quiet command nobody could clear: the one banner that is not about a finished round. */
export function quietBanner(event: {
  readonly teamName: string;
  readonly seat: string;
  readonly reason: string;
}): Banner {
  return { title: event.teamName, body: `「${event.seat}」的命令很久没有动静，请你看一眼：${event.reason}` };
}
