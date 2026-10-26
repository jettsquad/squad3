/**
 * team-log.ts — one team's append-only JSONL file.
 *
 * One line per event, written in full before the next is accepted. `seq` is
 * assigned here, from what is on disk, so two writers in one process cannot
 * hand out the same number. Two PROCESSES on one data directory is what the
 * single-instance lock is for — 2.x damaged two logs that way before it had one.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { asLogEvent, type TeamLogEntry, type TeamLogEvent } from "../../shared/team-log.ts";

export class TeamLog {
  private readonly path: string;
  private events: TeamLogEvent[] | undefined;

  constructor(path: string) {
    this.path = path;
  }

  /** Every event, in order. Fails loudly on anything it cannot read. */
  read(): readonly TeamLogEvent[] {
    if (this.events !== undefined) return this.events;
    if (!existsSync(this.path)) {
      this.events = [];
      return this.events;
    }
    const lines = readFileSync(this.path, "utf8").split("\n");
    const events: TeamLogEvent[] = [];
    lines.forEach((text, index) => {
      if (text.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`团队日志「${this.path}」第 ${index + 1} 行不是合法的 JSON。`);
      }
      const event = asLogEvent(parsed, index + 1);
      const expected = events.length + 1;
      if (event.seq !== expected) {
        throw new Error(`团队日志「${this.path}」第 ${index + 1} 行的序号是 ${event.seq}，应该是 ${expected}。`);
      }
      events.push(event);
    });
    this.events = events;
    return events;
  }

  /**
   * Add one event. `at` is now, except for an import, which keeps when the
   * thing was SAID — a record restored with today's times on every line would
   * read as a discussion that happened during the import.
   */
  append(entry: TeamLogEntry, at: number = Date.now()): TeamLogEvent {
    const events = this.read() as TeamLogEvent[];
    const event = { ...entry, seq: events.length + 1, at } as TeamLogEvent;
    mkdirSync(dirname(this.path), { recursive: true });
    // Synchronous, so the line is on disk before anyone is told it happened.
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
    events.push(event);
    return event;
  }
}
