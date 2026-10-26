// 移植自 Squad 2.x packages/shared/test/host-name.test.ts @ 8dcb903
/**
 * 「主持人」是常量时，这个字段贯穿了 domain、存储和每一轮席位提示词，
 * 却只有一个可能的取值。这些用例锁住的是它现在有几种取值、以及取不到时
 * 回落到哪里——空字符串必须回落，因为它会以「主持人：」后面什么都没有的
 * 形式进到提示词里，模型读到的是一个坏掉的字段而不是一个人。
 */
import { describe, expect, it } from "vitest";
import { hostNameOrDefault as resolve } from "../src/shared/host-name.ts";

describe("称呼的回落", () => {
  it("没设过就是默认值", () => {
    expect(resolve(undefined)).toBe("主持人");
  });

  it("空的和全是空格的都回落，不会变成空名字", () => {
    // 「主持人：」后面什么都没有，比默认值糟得多。
    expect(resolve("")).toBe("主持人");
    expect(resolve("   ")).toBe("主持人");
  });

  it("设过就用设的，两头空格去掉", () => {
    expect(resolve("Alex")).toBe("Alex");
    expect(resolve("  老王  ")).toBe("老王");
  });
});
