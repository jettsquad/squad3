// 移植自 Squad 2.x packages/context/test/window.test.ts @ 8dcb903
/**
 * Quoting is emphasis, not a filter.
 *
 * The assembler used to pick one or the other — quotes if any, else the
 * previous round — so pointing at an older reply silently removed the
 * conversation the agent had just taken part in. Asking for focus cost it
 * context, which is the opposite of the intent.
 */

import { describe, expect, it } from "vitest";
import { selectContextEvents, QUOTED_PREFIX, type SelectableEvent } from "../src/main/context/window.ts";

const host = (text: string): SelectableEvent => ({ kind: "hostMessage", text });
const reply = (seatId: string, taskId: string, message: string, turnId?: string): SelectableEvent => ({
  kind: "discussionTurnEnd",
  seatId,
  taskId,
  message,
  ...(turnId === undefined ? {} : { turnId }),
});

describe("selectContextEvents", () => {
  it("carries the whole discussion when nothing has been checkpointed", () => {
    // An agent is a new process every turn: it knows only what it is handed.
    // Carrying one round left it unable to remember a discussion it had been
    // part of. The bound on this window is the checkpoint threshold.
    const events = [
      host("更早的问题"),
      reply("s1", "t0", "更早的回答"),
      host("最近的问题"),
      reply("s1", "t1", "最近的回答"),
    ];
    expect(selectContextEvents(events).map((e) => e.text ?? e.message)).toEqual([
      "更早的问题",
      "更早的回答",
      "最近的问题",
      "最近的回答",
    ]);
  });

  it("keeps the round when the host also quotes something", () => {
    // The regression this module exists for.
    const events = [host("最近的问题"), reply("s1", "t1", "最近的回答")];
    const quoted = [reply("s2", "old", "很久以前的一段")];
    const selected = selectContextEvents(events, quoted);
    expect(selected.map((e) => e.text ?? e.message)).toEqual([
      `${QUOTED_PREFIX}很久以前的一段`,
      "最近的问题",
      "最近的回答",
    ]);
  });

  it("marks a quote so the emphasis survives into the prompt", () => {
    const selected = selectContextEvents([], [reply("s2", "old", "被引用的内容")]);
    expect(selected[0]?.message).toBe(`${QUOTED_PREFIX}被引用的内容`);
  });

  it("marks a quote in place rather than sending the text twice", () => {
    // Quoting a reply from the round itself is the common case; paying for a
    // second copy of it would be the wrong kind of emphasis.
    const inRound = reply("s1", "t1", "本轮的回答", "turn-1");
    const selected = selectContextEvents([host("问题"), inRound], [inRound]);
    expect(selected).toHaveLength(2);
    expect(selected[1]?.message).toBe(`${QUOTED_PREFIX}本轮的回答`);
  });

  it("distinguishes two executions of the same task id", () => {
    // Task ids repeat across rounds; the turn id is what identifies a run.
    const older = reply("s1", "shared", "第一次的回答", "turn-1");
    const newer = reply("s1", "shared", "第二次的回答", "turn-2");
    const selected = selectContextEvents([host("问题"), newer], [older]);
    // Both runs are present: the quoted one is not mistaken for the round's.
    expect(selected.filter((e) => e.kind === "discussionTurnEnd").map((e) => e.message)).toEqual([
      `${QUOTED_PREFIX}第一次的回答`,
      "第二次的回答",
    ]);
  });

  it("falls back to seat and task when a transcript predates turn ids", () => {
    const legacy = reply("s1", "t1", "旧记录里的回答");
    const selected = selectContextEvents([host("问题"), legacy], [legacy]);
    expect(selected).toHaveLength(2);
    expect(selected[1]?.message).toBe(`${QUOTED_PREFIX}旧记录里的回答`);
  });

  it("returns everything it was given when no host message has been recorded", () => {
    const events = [reply("s1", "t1", "没有主持人消息的记录")];
    expect(selectContextEvents(events)).toHaveLength(1);
  });

  it("returns nothing for an empty transcript with no quotes", () => {
    expect(selectContextEvents([])).toEqual([]);
  });
});

describe("selectContextEvents with a checkpoint", () => {
  const checkpoint = (text: string): SelectableEvent => ({ kind: "contextCheckpoint", message: text });

  it("carries the checkpoint and everything after it, not just the last round", () => {
    // That is the point of a checkpoint: earlier turns are represented by it,
    // and everything since has not been summarised yet, so it travels whole.
    const events = [
      host("很早的问题"),
      reply("s1", "t0", "很早的回答"),
      checkpoint("## 当前目标\n..."),
      host("第一个问题"),
      reply("s1", "t1", "第一个回答"),
      host("第二个问题"),
      reply("s1", "t2", "第二个回答"),
    ];
    expect(selectContextEvents(events).map((e) => e.text ?? e.message)).toEqual([
      "## 当前目标\n...",
      "第一个问题",
      "第一个回答",
      "第二个问题",
      "第二个回答",
    ]);
  });

  it("drops everything before the checkpoint", () => {
    const events = [host("检查点之前"), reply("s1", "t0", "旧的回答"), checkpoint("摘要"), host("之后")];
    const texts = selectContextEvents(events).map((e) => e.text ?? e.message);
    expect(texts).not.toContain("旧的回答");
    expect(texts).not.toContain("检查点之前");
  });

  it("uses only the newest checkpoint", () => {
    // Two checkpoints would bill the same history twice and can contradict
    // each other — the later one already inherits the earlier.
    const events = [checkpoint("第一份"), host("中间"), checkpoint("第二份"), host("之后")];
    const texts = selectContextEvents(events).map((e) => e.text ?? e.message);
    expect(texts).toEqual(["第二份", "之后"]);
  });

  it("carries everything when no checkpoint exists", () => {
    // Forgetting is the problem being solved; it must not wait for the host
    // to press a button. The threshold, not the window, is the upper bound.
    const events = [host("旧问题"), reply("s1", "t0", "旧回答"), host("新问题"), reply("s1", "t1", "新回答")];
    expect(selectContextEvents(events).map((e) => e.text ?? e.message)).toEqual([
      "旧问题",
      "旧回答",
      "新问题",
      "新回答",
    ]);
  });

  it("still lets a quote reach back past the checkpoint", () => {
    // Compaction is "not carried by default", not "deleted" — the host can
    // always pull an original forward.
    const old = reply("s1", "t0", "检查点之前的一段");
    const events = [host("很早"), old, checkpoint("摘要"), host("现在")];
    const texts = selectContextEvents(events, [old]).map((e) => e.text ?? e.message);
    expect(texts).toContain(`${QUOTED_PREFIX}检查点之前的一段`);
  });

  // The secretary writes without stopping the team, so turns keep landing
  // while it works and are recorded BEFORE the checkpoint that does not
  // contain them. Cutting at the event's position would delete them.
  it("keeps turns that landed while the checkpoint was being written", () => {
    const covered = reply("s1", "t0", "被总结的回答", "turn-0");
    const during = reply("s1", "t1", "总结期间的回答", "turn-1");
    const events = [
      host("很早"),
      covered,
      host("总结期间的问题"),
      during,
      { kind: "contextCheckpoint", message: "摘要", coversUpTo: "turn-0" } as SelectableEvent,
    ];
    const texts = selectContextEvents(events).map((e) => e.text ?? e.message);
    expect(texts).toEqual(["摘要", "总结期间的问题", "总结期间的回答"]);
  });

  it("falls back to the checkpoint's position when it records no coverage", () => {
    // Transcripts written before coversUpTo existed still assemble correctly.
    const events = [host("之前"), checkpoint("摘要"), host("之后")];
    expect(selectContextEvents(events).map((e) => e.text ?? e.message)).toEqual(["摘要", "之后"]);
  });

  it("falls back to the previous checkpoint when the newest is revoked", () => {
    const events: readonly SelectableEvent[] = [
      { kind: "contextCheckpoint", message: "第一份", checkpointId: "cp-1" },
      host("中间"),
      { kind: "contextCheckpoint", message: "第二份", checkpointId: "cp-2" },
      host("之后"),
      { kind: "checkpointRevoked", checkpointId: "cp-2" },
    ];
    const texts = selectContextEvents(events).map((e) => e.text ?? e.message);
    expect(texts).toEqual(["第一份", "中间", "之后"]);
  });

  it("carries the whole history again when every checkpoint is revoked", () => {
    // A revoked checkpoint stops being context of any kind: the history it
    // was hiding comes back, and it does not linger as a contribution.
    const events: readonly SelectableEvent[] = [
      host("很早"),
      { kind: "contextCheckpoint", message: "摘要", checkpointId: "cp-1" },
      host("之后"),
      { kind: "checkpointRevoked", checkpointId: "cp-1" },
    ];
    expect(selectContextEvents(events).map((e) => e.text ?? e.message)).toEqual(["很早", "之后"]);
  });
});
