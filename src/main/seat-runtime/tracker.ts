// 移植自 Squad 2.x packages/seat-runtime/src/tracker.ts @ 8dcb903
/**
 * tracker.ts — the part of following a seat's output every backend shares.
 *
 * Both CLIs that stream speak JSONL, and both are read in pieces that end
 * wherever the pipe happened to be when the watchdog looked. Splitting that
 * into whole lines is the same job twice, and the place a half-read line gets
 * parsed as garbage and silently dropped.
 */

/**
 * One thing a seat has started and not finished.
 *
 * 移植自 Squad 2.x packages/seat-runtime/src/activity.ts 的 `OpenCommand` @ 8dcb903
 */
export interface OpenCommand {
  readonly id: string;
  /** The tool's own name — `Bash`, `command_execution`. */
  readonly tool: string;
  /** What it was asked to do, as the seat wrote it. */
  readonly command: string;
  readonly startedAt: number;
  /** Handed off so the seat could carry on; the turn still waits for it. */
  readonly background: boolean;
  /** Where the command's own output is being written, when the CLI said. */
  readonly outputFile?: string | undefined;
}

/**
 * Follows a seat's output as it arrives and says what is still open.
 *
 * 移植自 Squad 2.x packages/seat-runtime/src/index.ts 的 `StreamTracker` @ 8dcb903
 *
 * Fed in pieces, in order, and a piece may end mid-line.
 */
export interface StreamTracker {
  feed(chunk: string, at?: number): void;
  /** What the stream says was started and not finished. */
  open(): readonly OpenCommand[];
  /** The last thing the seat said in words. */
  lastWords(): string | undefined;
}

/** How much of a command to keep. Enough to recognise it, not a script. */
export const COMMAND_SHOWN_CHARS = 300;

/** A command as it should be shown: one line, bounded. */
export function shownCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  return flat.length <= COMMAND_SHOWN_CHARS ? flat : `${flat.slice(0, COMMAND_SHOWN_CHARS)}…`;
}

/**
 * Turn chunks of JSONL into events, holding back a line until it is whole.
 *
 * A line that is not JSON is skipped, not thrown on: a CLI may print a plain
 * warning between events, and losing track of what a seat is doing over one
 * stray line would be the tracker failing at the only thing it is for.
 */
export function jsonLineFeeder(
  onEvent: (event: Record<string, unknown>, at: number) => void,
): (chunk: string, at?: number) => void {
  let rest = "";
  return (chunk, at = Date.now()) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const event: unknown = JSON.parse(trimmed);
        if (typeof event === "object" && event !== null) onEvent(event as Record<string, unknown>, at);
      } catch {
        // Not an event.
      }
    }
  };
}
