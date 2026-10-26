// 移植自 Squad 2.x packages/reasoning/test/pool.test.ts @ 8dcb903
/**
 * Sharing must not become a sync, a replacement, or an averaging machine.
 * Each of those failures is quiet: the library still has criteria in it, they
 * just stop being the owner's.
 */
import { describe, expect, it } from "vitest";
import { exportToPool, importAsCandidates, mergeIntoPool, type PoolEntry } from "../src/main/reasoning/pool.ts";
import type { Criterion } from "../src/main/reasoning/criterion.ts";

const criterion = (over: Partial<Criterion> = {}): Criterion => ({
  id: "c1",
  trigger: { action: ["design-mechanism"], features: ["automatic"] },
  claim: "不可见的自动机制，其失败模式必然是静默的。",
  evidence: ["i-1", "i-2", "i-3"],
  status: "active",
  ...over,
});

describe("exportToPool", () => {
  it("sends the abstract and a count, never the instances", () => {
    // The export boundary was already the directory split; this reuses it
    // rather than inventing a second rule that could disagree.
    const { entries } = exportToPool([criterion()]);
    expect(entries[0]?.support).toEqual({ users: 1, instances: 3 });
    expect(JSON.stringify(entries[0])).not.toContain("i-1");
  });

  it("holds back a criterion still tied to one place", () => {
    // Refused, not scrubbed: deleting the names would send a stranger a
    // sentence that no longer means anything, and it would pass the check
    // while being less useful than not sending it.
    const { entries, refused } = exportToPool([criterion({ claim: "改 src/main/team-store.ts 时先看配置" })]);
    expect(entries).toEqual([]);
    expect(refused[0]?.markers[0]?.kind).toBe("path");
  });

  it("checks the boundary too, not just the claim", () => {
    // A boundary is where a criterion does NOT apply — the half most likely
    // to name the specific case it was learned from.
    const { refused } = exportToPool([criterion({ boundary: "在 Squad 里不适用" })], { names: ["Squad"] });
    expect(refused).toHaveLength(1);
  });

  it("exports only what it was handed", () => {
    // Opt-in one at a time by construction. A function that exported the
    // whole library would make opting in the default, which is the same as
    // not having one.
    expect(exportToPool([]).entries).toEqual([]);
  });
});

describe("importAsCandidates", () => {
  const entry: PoolEntry = {
    trigger: { action: ["design-mechanism"], features: ["automatic"] },
    claim: "别人写的一条主张",
    support: { users: 12, instances: 40 },
  };

  it("brings in no evidence at all", () => {
    // Support in the pool is other people's occasions. Carried in as this
    // library's own, a criterion would arrive already looking well-tested
    // here, and the confidence bound would be computed from experiences its
    // owner never had.
    expect(importAsCandidates([entry])[0]?.evidence).toEqual([]);
  });

  it("keeps the trigger and the claim", () => {
    const [candidate] = importAsCandidates([entry]);
    expect(candidate?.claim).toBe("别人写的一条主张");
    expect(candidate?.trigger.action).toEqual(["design-mechanism"]);
  });

  it("gives arrivals distinct ids", () => {
    const candidates = importAsCandidates([entry, entry]);
    expect(candidates[0]?.id).not.toBe(candidates[1]?.id);
  });
});

describe("mergeIntoPool", () => {
  const mine: PoolEntry = {
    trigger: { action: ["design-mechanism"], features: ["automatic"] },
    claim: "同一条主张",
    support: { users: 1, instances: 3 },
  };

  it("accumulates support for a claim others already hold", () => {
    const pool = mergeIntoPool([{ ...mine, support: { users: 4, instances: 20 } }], [mine]);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.support).toEqual({ users: 5, instances: 23 });
  });

  it("never rewrites the wording toward the middle", () => {
    // The averaging failure. A pool whose default is everyone's consensus
    // produces a mediocre middle, and this framework's value is that it takes
    // positions — consensus files the edges off.
    const existing = { ...mine, claim: "同一条主张", boundary: "原来的边界" };
    const pool = mergeIntoPool([existing], [{ ...mine, boundary: "别人的边界" }]);
    expect(pool[0]?.boundary).toBe("原来的边界");
  });

  it("keeps a genuinely different claim as its own entry", () => {
    expect(mergeIntoPool([mine], [{ ...mine, claim: "另一条主张" }])).toHaveLength(2);
  });
});
