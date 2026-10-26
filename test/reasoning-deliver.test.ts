// 移植自 Squad 2.x packages/reasoning/test/deliver.test.ts @ 8dcb903
/**
 * Delivery. The budget and the audience are the two things that keep a
 * criteria library from turning into either noise or an echo chamber, and
 * both are enforced here rather than left to whoever renders the result.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_LIMIT,
  buildSelectionPrompt,
  formatForSystemChannel,
  parseSelection,
  triggerMatches,
} from "../src/main/reasoning/deliver.ts";
import type { Criterion } from "../src/main/reasoning/criterion.ts";
import type { Situation } from "../src/shared/index.ts";

const make = (id: string, over: Partial<Criterion> = {}): Criterion => ({
  id,
  trigger: { action: ["design-mechanism"], features: ["automatic"] },
  claim: `${id} 的主张`,
  evidence: ["i-1"],
  status: "active",
  ...over,
});

const situation: Situation = {
  action: "design-mechanism",
  features: ["automatic", "invisible-result"],
};

describe("triggerMatches", () => {
  it("admits a situation carrying every required feature", () => {
    expect(triggerMatches(make("c1"), situation)).toBe(true);
  });

  it("admits a partial feature overlap, on purpose", () => {
    // Corrected against evidence: as a strict conjunction, a criterion filed
    // under {automatic, invisible-result} missed a phase labelled
    // {automatic, changes-default} — two model calls labelling the same
    // situation from a closed list, both defensibly, and disagreeing. The
    // asymmetry settles it: over-fetching is dropped by the selection step,
    // under-fetching is never seen by anything that could judge it.
    const overlapping = make("c2", {
      trigger: { action: ["design-mechanism"], features: ["automatic", "irreversible"] },
    });
    expect(triggerMatches(overlapping, situation)).toBe(true);
  });

  it("rejects a trigger sharing no feature at all with the situation", () => {
    // Coarse, not absent. Nothing in common is still nothing in common.
    const unrelated = make("c2b", {
      trigger: { action: ["design-mechanism"], features: ["benchmark-backed"] },
    });
    expect(triggerMatches(unrelated, situation)).toBe(false);
  });

  it("fires on the action alone when the trigger names no features", () => {
    const broad = make("c2c", { trigger: { action: ["design-mechanism"], features: [] } });
    expect(triggerMatches(broad, { action: "design-mechanism", features: [] })).toBe(true);
  });

  it("does not match a different action", () => {
    expect(triggerMatches(make("c3"), { ...situation, action: "produce-document" })).toBe(false);
  });

  it("never surfaces a retired criterion", () => {
    expect(triggerMatches(make("c4", { status: "retired" }), situation)).toBe(false);
  });

  it("still surfaces a suspect one", () => {
    // Suspect means "under review", not "withdrawn". Hiding it would remove
    // the thing most likely to attract the counter-example that settles it.
    expect(triggerMatches(make("c5", { status: "suspect" }), situation)).toBe(true);
  });

  it("honours a step restriction when the criterion carries one", () => {
    const stepped = make("c6", {
      trigger: { action: ["design-mechanism"], features: ["automatic"], step: ["evaluate"] },
    });
    expect(triggerMatches(stepped, situation)).toBe(false);
    expect(triggerMatches(stepped, { ...situation, step: "evaluate" })).toBe(true);
  });
});

describe("parseSelection", () => {
  const candidates = [make("c1"), make("c2"), make("c3"), make("c4")];

  it("keeps the chosen criteria in the order the model gave", () => {
    expect(parseSelection('["c3","c1"]', candidates).map((c) => c.id)).toEqual(["c3", "c1"]);
  });

  it("caps at the budget even when the model ignores it", () => {
    // A budget that depends on a model honouring it is not a budget.
    expect(parseSelection('["c1","c2","c3","c4"]', candidates)).toHaveLength(DELIVERY_LIMIT);
  });

  it("refuses an id that was never offered", () => {
    // Dropping it silently would deliver fewer criteria than intended and
    // look identical to a library that simply had nothing to say.
    expect(() => parseSelection('["c9"]', candidates)).toThrow(/c9/);
  });

  it("accepts an empty selection", () => {
    expect(parseSelection("[]", candidates)).toEqual([]);
  });
});

describe("formatForSystemChannel", () => {
  it("说的是「这一步我按的是」，不是「以下判据生效中」", () => {
    // 事前提醒会被跳过——这些标准是主持人自己写的，他知道。事后声明说的是
    // 他唯一给不了自己的那件事：这一次真正起作用的是哪一条。
    const text = formatForSystemChannel([make("c1")]);
    expect(text).toContain("这一步我按的是");
    expect(text).not.toContain("现在生效中");
  });

  it("说得出为什么是这几条", () => {
    // 「用了哪条」只是一半，「为什么」是另一半，而处境特征就是那个为什么。
    const text = formatForSystemChannel([make("c1")], ["automatic", "invisible-result"]);
    expect(text).toContain("automatic");
    expect(text).toContain("invisible-result");
  });

  it("shows what each one grew from", () => {
    // A wrong abstraction should be obvious at a glance rather than taken on
    // the system's word.
    const text = formatForSystemChannel([make("c1", { evidence: ["i-a", "i-b"] })]);
    expect(text).toContain("2 次实例");
  });

  it("shows the boundary when one has grown", () => {
    const text = formatForSystemChannel([make("c1", { boundary: "平凡可逆时不适用" })]);
    expect(text).toContain("平凡可逆时不适用");
  });

  it("没有可说的就一个字都不说", () => {
    // 「这次没有可用的判据」是一句关于机器自身的话，印进一场没有在问它的
    // 讨论里，只是噪音。
    expect(formatForSystemChannel([])).toBe("");
  });
});

describe("buildSelectionPrompt", () => {
  it("tells the model to respect boundaries over claims", () => {
    const prompt = buildSelectionPrompt(situation, [make("c1", { boundary: "平凡可逆时不适用" })]);
    expect(prompt).toContain("适用边界");
    expect(prompt).toContain("平凡可逆时不适用");
  });

  it("asks for fewer rather than more", () => {
    // Over-delivering gets the whole block skipped, which is worse than
    // delivering nothing — it costs the budget AND the attention.
    expect(buildSelectionPrompt(situation, [make("c1")])).toContain("宁少勿多");
  });
});

describe("parseSelection tolerance", () => {
  const candidates = [make("c1"), make("c2")];

  it("reads an array of objects carrying ids", () => {
    // Seen in a real run: the model answered [{"id": "..."}] and the whole
    // delivery failed, leaving the host with nothing over a formatting
    // preference. Surfaced only once selection started running on every
    // non-empty candidate list rather than only over budget.
    expect(parseSelection('[{"id":"c2"}]', candidates).map((c) => c.id)).toEqual(["c2"]);
  });

  it("still refuses an element with no readable id", () => {
    // Tolerance is bounded. Guessing past this point would deliver criteria
    // nobody chose.
    expect(() => parseSelection("[42]", candidates)).toThrow(/读不出 id/);
  });
});

describe("投放边界", () => {
  it("这个模块里没有任何一处把判据交给讨论记录", () => {
    // 靠拓扑守住，不靠人记得遵守。判据一旦作为 user/message 落进记录，
    // 下一轮每个席位的窗口都会带上它——而席位知道了主持人的判断标准就会去
    // 迎合它，五个人开始猜同一个答案，圆桌就不产生新信息了。
    //
    // 这条测试读源码文本：能证明「不存在这条路径」的检查，只能是这一种。
    const source = readFileSync(new URL("../src/main/reasoning/deliver.ts", import.meta.url), "utf8");
    expect(source).not.toContain("recordSpoken");
    expect(source).not.toContain("session.append");
    expect(source).not.toContain("user/message");
  });
});
