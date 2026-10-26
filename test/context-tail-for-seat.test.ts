// 移植自 Squad 2.x packages/context/test/tail-for-seat.test.ts @ 8dcb903
/**
 * 增量窗口。
 *
 * 这里错了会很安静：席位少看到一段，照样自信地答，读起来像是它读了却忽略
 * 了——而不是像一个没拿到材料的人。所以边界都要钉死。
 */
import { describe, expect, it } from "vitest";
import { tailForSeat, tailSince, type SelectableEvent } from "../src/main/context/window.ts";

const said = (speaker: string, text: string, turnId: string): SelectableEvent => ({
  kind: "user/message",
  text: `【${speaker}】${text}`,
  turnId,
});

describe("tailForSeat", () => {
  it("只给这个席位上次发言之后的内容", () => {
    // 它自己的 CLI 会话里已经有到那一句为止的一切，再发一遍就是同一段文字
    // 在提示词里出现两次，而且每轮都多一层。
    const events = [
      said("主持人", "第一个问题", "t1"),
      said("周", "周的答复", "t2"),
      said("卫七", "卫七的答复", "t3"),
      said("主持人", "第二个问题", "t4"),
    ];
    const tail = tailForSeat(events, "周");
    expect(tail.map((e) => e.turnId)).toEqual(["t3", "t4"]);
  });

  it("从没发过言就给全部", () => {
    // 第一轮：没有对话可续，也没有东西可裁。
    const events = [said("主持人", "问题", "t1"), said("卫七", "答复", "t2")];
    expect(tailForSeat(events, "周")).toHaveLength(2);
  });

  it("取最后一次发言，不是第一次", () => {
    const events = [
      said("周", "第一轮答复", "t1"),
      said("主持人", "追问", "t2"),
      said("周", "第二轮答复", "t3"),
      said("主持人", "再追问", "t4"),
    ];
    expect(tailForSeat(events, "周").map((e) => e.turnId)).toEqual(["t4"]);
  });

  it("刚说完还没有新内容时是空的", () => {
    // 空窗口是合法结果：它意味着这个席位已经知道一切。调用方不该把它当成
    // 装配失败。
    const events = [said("主持人", "问题", "t1"), said("周", "答复", "t2")];
    expect(tailForSeat(events, "周")).toEqual([]);
  });

  it("名字前缀相同的两个席位不会互相当成对方", () => {
    // 「周」和「周一」——按 includes 或裸前缀匹配会串。
    const events = [
      said("周一", "一的答复", "t1"),
      said("主持人", "问题", "t2"),
      said("周", "周的答复", "t3"),
      said("主持人", "再问", "t4"),
    ];
    expect(tailForSeat(events, "周").map((e) => e.turnId)).toEqual(["t4"]);
    expect(tailForSeat(events, "周一").map((e) => e.turnId)).toEqual(["t2", "t3", "t4"]);
  });

  it("不带 text 的事件（比如检查点条目）不会被误判成发言", () => {
    const events: SelectableEvent[] = [
      { kind: "contextCheckpoint", message: "【周】看起来像发言但不是", turnId: "c1" },
      said("主持人", "问题", "t1"),
    ];
    expect(tailForSeat(events, "周")).toHaveLength(2);
  });
});

describe("tailSince", () => {
  it("别的席位在它答题期间说的话，下一轮不会漏掉", () => {
    // 并行之后，卫七可以在周还在答的时候答完。卫七那句落在周的答复之前，
    // 按「上次发言之后」截就永远送不到周手上。
    const events = [
      said("主持人", "问周", "t1"),
      said("主持人", "问卫七", "t2"),
      // 周开工时窗口取到 t2 为止。
      said("卫七", "卫七的答复", "t3"),
      said("周", "周的答复", "t4"),
      said("主持人", "再问周", "t5"),
    ];
    expect(tailForSeat(events, "周").map((e) => e.turnId)).toEqual(["t5"]);
    expect(tailSince(events, "t2", "周").map((e) => e.turnId)).toEqual(["t3", "t5"]);
  });

  it("它自己说过的话不再发一遍", () => {
    // 那些在它自己的 CLI 对话里已经有了。
    const events = [said("主持人", "问", "t1"), said("周", "答", "t2"), said("主持人", "再问", "t3")];
    expect(tailSince(events, "t1", "周").map((e) => e.turnId)).toEqual(["t3"]);
  });

  it("找不到上次看到的位置（重启过、或被检查点截掉），退回按发言截", () => {
    const events = [said("主持人", "问", "t1"), said("周", "答", "t2"), said("主持人", "再问", "t3")];
    expect(tailSince(events, "gone", "周")).toEqual(tailForSeat(events, "周"));
  });
});
