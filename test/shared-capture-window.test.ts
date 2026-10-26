// 移植自 Squad 2.x packages/shared/test/capture-window.test.ts @ 8dcb903
/**
 * 采集窗口。这是「记下来」这个按钮里唯一有判断的部分——`capture` 要的是
 * 一对（机器提议了什么 / 人怎么裁的），而按钮只提供后一半。前一半取错了，
 * 蒸馏出来的就不是标准，是一句没有对象的意见。
 */
import { describe, expect, it } from "vitest";
import { captureWindow, type SpokenLine } from "../src/shared/capture-window.ts";

const line = (speaker: string, text: string, turnId: string): SpokenLine => ({ speaker, text, turnId });

const 主持人 = "主持人";

describe("captureWindow", () => {
  it("取上一条自己发言之后、所有席位说的话", () => {
    const transcript = [
      line(主持人, "第一个问题", "t1"),
      line("甲", "甲的答复", "t2"),
      line("乙", "乙的答复", "t3"),
      line(主持人, "不对，应该先算迁移成本", "t4"),
    ];
    const w = captureWindow(transcript, 主持人, "t4");
    expect(w?.verdict).toBe("不对，应该先算迁移成本");
    expect(w?.proposed).toContain("甲的答复");
    expect(w?.proposed).toContain("乙的答复");
    expect(w?.from).toEqual(["甲", "乙"]);
  });

  it("更早的轮次不算——那是已经做完的决定", () => {
    const transcript = [
      line(主持人, "问题一", "t1"),
      line("甲", "上一轮的答复", "t2"),
      line(主持人, "问题二", "t3"),
      line("甲", "这一轮的答复", "t4"),
      line(主持人, "这样不行", "t5"),
    ];
    const w = captureWindow(transcript, 主持人, "t5");
    expect(w?.proposed).toContain("这一轮的答复");
    expect(w?.proposed).not.toContain("上一轮的答复");
  });

  it("@ 了某个席位就只取它的答复", () => {
    // 指着谁说话，就是在说这句是在回应哪一条——这是唯一一种配对被明说
    // 而不是被推断的情况。
    const transcript = [
      line(主持人, "都说说", "t1"),
      line("甲", "甲的答复", "t2"),
      line("乙", "乙的答复", "t3"),
      line(主持人, "@乙 你这个前提不成立", "t4"),
    ];
    const w = captureWindow(transcript, 主持人, "t4", ["乙"]);
    expect(w?.proposed).toContain("乙的答复");
    expect(w?.proposed).not.toContain("甲的答复");
    expect(w?.from).toEqual(["乙"]);
  });

  it("@ 的席位这一轮没说话，就退回全部，而不是变成空", () => {
    const transcript = [
      line(主持人, "都说说", "t1"),
      line("甲", "甲的答复", "t2"),
      line(主持人, "@丙 你怎么看，另外甲这个不对", "t3"),
    ];
    const w = captureWindow(transcript, 主持人, "t3", ["丙"]);
    expect(w?.proposed).toContain("甲的答复");
  });

  it("中间没人说话，proposed 留空但仍然采集", () => {
    // 连着说两条，可能是在直接立规矩，不是在否决谁。
    const transcript = [line(主持人, "先说一句", "t1"), line(主持人, "以后一律先给结论", "t2")];
    const w = captureWindow(transcript, 主持人, "t2");
    expect(w?.proposed).toBe("");
    expect(w?.verdict).toBe("以后一律先给结论");
    expect(w?.from).toEqual([]);
  });

  it("点在别人的发言上不给窗口", () => {
    // 判据是你的标准，不是别人的观点。按钮只挂在你自己的发言上，走到这里
    // 就是调用错了。
    const transcript = [line(主持人, "问题", "t1"), line("甲", "甲的答复", "t2")];
    expect(captureWindow(transcript, 主持人, "t2")).toBeUndefined();
  });

  it("turnId 找不到就是 undefined", () => {
    expect(captureWindow([line(主持人, "x", "t1")], 主持人, "nope")).toBeUndefined();
  });
});
