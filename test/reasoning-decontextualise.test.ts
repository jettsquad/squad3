// 移植自 Squad 2.x packages/reasoning/test/decontextualise.test.ts @ 8dcb903
/**
 * §7.4's test, applied to §7.3's own example. A claim that stops holding once
 * its context is stripped was never an abstract — it is an instance that got
 * mistaken for one — and that turns "is this general enough?" from a matter
 * of taste into something checkable.
 */
import { describe, expect, it } from "vitest";
import { checkAbstractness, findContextMarkers } from "../src/main/reasoning/decontextualise.ts";

// Verbatim from the design, both halves.
const stillAnInstance =
  "在 Squad 的 electron-entry.ts 里改 applyTeamConfig 时不要调 teamRegistry.get()，它会触发 rehydrate 导致递归";
const anAbstract =
  "一个会被惰性重建路径调用的函数，内部不能再调用那条重建路径的入口——因为入口通常带着「没有就建一个」的语义。这种位置要用一个只读不重建的访问器。";

describe("the design's own example", () => {
  it("rejects the version that is still an instance", () => {
    const report = checkAbstractness(stillAnInstance, { names: ["Squad"] });
    expect(report.abstract).toBe(false);
    expect(report.markers.map((marker) => marker.kind)).toContain("path");
    expect(report.markers.map((marker) => marker.kind)).toContain("name");
  });

  it("accepts the version that is genuinely abstract", () => {
    // Holds for any system with lazy initialisation, and has nothing to do
    // with Squad, Electron or TypeScript.
    expect(checkAbstractness(anAbstract, { names: ["Squad"] }).abstract).toBe(true);
  });

  it("tells the writer to find the principle, not to delete the names", () => {
    // Deleting `electron-entry.ts` from the first sentence leaves a sentence
    // that still only makes sense to someone who knows the codebase.
    expect(checkAbstractness(stillAnInstance).advice).toContain("一般性的原则");
  });
});

describe("findContextMarkers", () => {
  it("catches file paths and bare file names", () => {
    expect(findContextMarkers("改 src/main/team-store.ts 之前先看 config.json").map((m) => m.text)).toEqual([
      "src/main/team-store.ts",
      "config.json",
    ]);
  });

  it("catches a specific function call", () => {
    expect(findContextMarkers("不要调 registry.get()")[0]?.kind).toBe("identifier");
  });

  it("catches a URL", () => {
    expect(findContextMarkers("见 https://example.com/doc")[0]?.kind).toBe("url");
  });

  it("catches names only when the caller supplies them", () => {
    // No regex knows that "Squad" is a project here and an ordinary word
    // elsewhere. Guessing would either miss real names or reject sentences
    // for containing common ones.
    expect(findContextMarkers("Squad 的做法")).toEqual([]);
    expect(findContextMarkers("Squad 的做法", { names: ["Squad"] })[0]?.kind).toBe("name");
  });

  it("does not report the same marker twice", () => {
    expect(findContextMarkers("a/b.ts 和 a/b.ts")).toHaveLength(1);
  });

  it("leaves ordinary prose alone", () => {
    // The check has to be quiet on a real abstract or it becomes noise that
    // gets switched off.
    expect(findContextMarkers("不可见的自动机制，其失败模式必然是静默的。要么让结果可见，要么不要自动。")).toEqual([]);
  });

  it("is honest about what it cannot see", () => {
    // The corrected example still presumes lazy rebuilding exists. Passing
    // this check is not a claim that the domain assumption is gone.
    expect(checkAbstractness(anAbstract).advice).toContain("隐含的领域假设查不了");
  });
});
