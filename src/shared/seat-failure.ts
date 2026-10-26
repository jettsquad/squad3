// 移植自 Squad 2.x packages/shared/src/seat-failure.ts @ 8dcb903
/**
 * seat-failure.ts — saying why a seat failed, in the words it failed in.
 *
 * A seat's failed turn used to be reported as the first line of whatever it
 * had said, and a seat says things before it fails: 「我先读正文和记录文件的
 * 当前状态」 was recorded as the reason one writer could not finish, while the
 * real reason — the API refused the rest of the turn — sat further down.
 * The proxy deciding what to do next read the narration, took it for an
 * ordinary unfinished job, and sent the same job back.
 */

/**
 * A refusal by the model service's own safety classifier.
 *
 * Not the network and not the task being too hard: the service withheld what
 * the seat was writing. Running the same job again meets the same refusal.
 */
export function isClassifierBlock(text: string): boolean {
  return /safeguards flagged|safety classifier|reasoning_extraction|usage policy|legal\/aup/i.test(text);
}

/**
 * The line that says why a failed seat failed.
 *
 * An `API Error` line wins over the seat's own narration, and carries the
 * service's `Details:` tag when there is one. Otherwise the first line, as before.
 */
export function seatFailureReason(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const error = [...lines].reverse().find((line) => /^(⚠️\s*)?API Error\b/i.test(line));
  if (error === undefined) return lines[0] ?? "";
  const tag = /Details:\s*`?(\[[^\]\s]+\])`?/.exec(text)?.[1];
  const short = error.length > 140 ? `${error.slice(0, 140)}…` : error;
  return tag === undefined || short.includes(tag) ? short : `${short} ${tag}`;
}
