import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TeamLog } from "../src/main/store/team-log.ts";
import { spokenLines } from "../src/shared/team-log.ts";

const fresh = (): string => join(mkdtempSync(join(tmpdir(), "squad-log-")), "log.jsonl");

describe("TeamLog", () => {
  it("numbers events from 1 without gaps and survives a reopen", () => {
    const path = fresh();
    const log = new TeamLog(path);
    log.append({ type: "host/message", commandId: "c1", text: "你好", seatIds: ["seat-1"], quoteIds: [] });
    log.append({ type: "seat/request", commandId: "c1", seatId: "seat-1", prompt: "P", contextLines: 0 });
    const reopened = new TeamLog(path).read();
    expect(reopened.map((event) => event.seq)).toEqual([1, 2]);
    expect(reopened[0]).toMatchObject({ type: "host/message", text: "你好" });
  });

  it("refuses an event type it does not know instead of skipping it", () => {
    // Skipping is 2.x's checkpoint bug: the reader dropped what it did not
    // recognise, and a whole stretch of history went missing without a word.
    const path = fresh();
    writeFileSync(path, `${JSON.stringify({ type: "squad/mystery", seq: 1, at: 1 })}\n`);
    expect(() => new TeamLog(path).read()).toThrow(/不认识/);
  });

  it("refuses a gap in the sequence", () => {
    const path = fresh();
    const line = (seq: number): string =>
      JSON.stringify({ type: "system/note", seq, at: 1, entryId: `e${seq}`, text: "x" });
    writeFileSync(path, `${line(1)}\n${line(3)}\n`);
    expect(() => new TeamLog(path).read()).toThrow(/序号/);
  });

  it("writes one JSON object per line", () => {
    const path = fresh();
    new TeamLog(path).append({
      type: "host/message",
      commandId: "c1",
      text: "多行\n指令",
      seatIds: ["s"],
      quoteIds: [],
    });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "").text).toBe("多行\n指令");
  });
});

describe("spokenLines", () => {
  it("lists what was said, by whom, under which id — and nothing that was not said", () => {
    const log = new TeamLog(fresh());
    log.append({ type: "host/message", commandId: "c1", text: "问题", seatIds: ["seat-1"], quoteIds: [] });
    log.append({ type: "seat/request", commandId: "c1", seatId: "seat-1", prompt: "整段提示词", contextLines: 0 });
    log.append({
      type: "seat/reply",
      commandId: "c1",
      entryId: "e1",
      seatId: "seat-1",
      displayName: "甲",
      text: "答",
      tag: "",
      failed: false,
      cancelled: false,
      durationMs: 1,
    });
    log.append({ type: "system/note", entryId: "e2", text: "⏹ 叫停" });
    log.append({ type: "checkpoint/recorded", checkpointId: "cp1", text: "要点", coversUpTo: "e1" });
    expect(spokenLines(log.read(), "主持人")).toEqual([
      { entryId: "c1", speaker: "主持人", text: "问题" },
      { entryId: "e1", speaker: "甲", text: "答" },
      { entryId: "e2", speaker: "系统", text: "⏹ 叫停" },
    ]);
  });
});
