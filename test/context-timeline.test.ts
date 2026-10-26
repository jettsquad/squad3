// 移植自 Squad 2.x packages/context/test/timeline.test.ts @ 8dcb903
// 改动：去掉「主持人节点跑过回合」那一条（3 没有主持人节点）；「覆盖 dsh 全部事件类型」
// 两条改成「覆盖装配层可能见到的全部三种事件」——它们守的是同一件事：新类型不能悄悄漏掉。
/**
 * The bug this layer exists for: 1.x's renderer ended in a catch-all that
 * returned nothing for any kind it had not been taught, so the context
 * checkpoint was cut out of history by the window and then thrown away here.
 * History gone, replacement gone, no error.
 */
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_TIMELINE_PREFIX,
  SPEECH_KIND,
  TIMELINE_IGNORED_KINDS,
  renderTimeline,
  renderTimelineEvent,
} from "../src/main/context/timeline.ts";
import { CHECKPOINT_KIND, CHECKPOINT_REVOKED_KIND, type SelectableEvent } from "../src/main/context/window.ts";

const speech = (text: string): SelectableEvent => ({ kind: SPEECH_KIND, text });
const checkpoint = (text: string): SelectableEvent => ({ kind: CHECKPOINT_KIND, text });

describe("renderTimelineEvent", () => {
  it("renders a line of the discussion", () => {
    expect(renderTimelineEvent(speech("【甲】我认为可以"))).toBe("【甲】我认为可以");
  });

  it("renders the checkpoint, and says what it is", () => {
    // The regression this module exists for: the checkpoint must reach the
    // seat, and it must arrive labelled — unlabelled it reads as somebody's
    // opinion rather than as a stand-in for detail that still exists.
    const line = renderTimelineEvent(checkpoint("要点一、要点二"));
    expect(line).toBe(`${CHECKPOINT_TIMELINE_PREFIX}\n\n要点一、要点二`);
  });

  it("strips reasoning again at render time", () => {
    // The log keeps what was recorded. A turn recorded before replies were
    // cleaned would otherwise go on feeding its reasoning to a seat.
    expect(renderTimelineEvent(speech("<think>盘算一下</think>结论是 A"))).toBe("结论是 A");
  });

  it("returns undefined for a kind that is deliberately not shown", () => {
    expect(renderTimelineEvent({ kind: CHECKPOINT_REVOKED_KIND })).toBeUndefined();
  });

  it("throws on a kind it has never been taught", () => {
    // The whole point: a new event kind fails loudly at introduction rather
    // than becoming a hole in what the seats can see.
    expect(() => renderTimelineEvent({ kind: "squad/somethingNew" })).toThrow(/未知事件类型/);
  });
});

describe("renderTimeline", () => {
  it("keeps transcript order and drops only the ignored kinds", () => {
    expect(
      renderTimeline([
        checkpoint("此前要点"),
        { kind: CHECKPOINT_REVOKED_KIND },
        speech("【主持人】继续"),
        speech("【甲】好"),
      ]),
    ).toEqual([`${CHECKPOINT_TIMELINE_PREFIX}\n\n此前要点`, "【主持人】继续", "【甲】好"]);
  });
});

describe("every kind the context layer can meet is handled", () => {
  // The merged stream is built from the team log and holds exactly these
  // three kinds. A fourth added there must fail here, in a test naming it,
  // rather than in a seat quietly not seeing something.
  const kinds = [SPEECH_KIND, CHECKPOINT_KIND, CHECKPOINT_REVOKED_KIND];

  it("renders or deliberately ignores each one", () => {
    for (const kind of kinds) {
      if (TIMELINE_IGNORED_KINDS.has(kind)) expect(renderTimelineEvent({ kind })).toBeUndefined();
      else expect(typeof renderTimelineEvent({ kind, text: "x" })).toBe("string");
    }
  });
});
