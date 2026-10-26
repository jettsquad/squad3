// 移植自 Squad 2.x packages/console/test/mention.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { parseMentions } from "../src/shared/mention.ts";

const seats = ["架构", "测试员", "架构组"];

describe("parseMentions", () => {
  it("开头的 @ 点名并且从正文里挖掉", () => {
    expect(parseMentions("@架构 看看这个", seats)).toMatchObject({ named: ["架构"], instruction: "看看这个" });
  });

  it("句中的 @ 点名，但正文原样保留", () => {
    // 曾经这里断言句中的 @ 不算点名。那条规则在屏幕上看不见：
    // 「问一下 @架构 和运维」看着是点了名，实际群发给所有人。
    expect(parseMentions("问一下 @架构 和运维", seats)).toMatchObject({
      named: ["架构"],
      instruction: "问一下 @架构 和运维",
    });
  });

  it("点多个人", () => {
    const got = parseMentions("@架构 @测试员 一起看", seats);
    expect(got.named).toEqual(["架构", "测试员"]);
    expect(got.instruction).toBe("一起看");
  });

  it("最长的名字优先", () => {
    // 「@架构组」不能被读成「@架构」加一个「组」字。
    expect(parseMentions("@架构组 来", seats).named).toEqual(["架构组"]);
  });

  it("点名和正文之间的标点被吃掉", () => {
    expect(parseMentions("@架构, @测试员： 说说", seats).instruction).toBe("说说");
  });

  it("名字打错了要说出来，不能当成没点名", () => {
    // 静悄悄地发给全团，而界面上看起来是只问了一个人——这是最坏的那种失败。
    const got = parseMentions("@架构师 看看", seats);
    expect(got.unknown).toEqual(["架构师"]);
    expect(got.named).toEqual([]);
  });

  it("不点名就是全体", () => {
    expect(parseMentions("大家说说", seats)).toMatchObject({ named: [], instruction: "大家说说" });
  });

  it("同一个人点两次只算一次", () => {
    expect(parseMentions("@架构 @架构 说", seats).named).toEqual(["架构"]);
  });
});

describe("句子中间的点名", () => {
  it("句中的 @名字 也算点名", () => {
    // 之前只认开头，于是「请 @吴二 复核」看着是点了名，实际静默群发给
    // 所有人——屏幕上没有任何东西说这件事。1.x 的规则是全文匹配。
    const parsed = parseMentions("这段请 @吴二 复核一下", ["吴二", "王四"]);
    expect(parsed.named).toEqual(["吴二"]);
  });

  it("句中的点名不从正文里挖掉", () => {
    // 开头的点名是纯地址，删掉不损失信息；句中的名字是句子的一部分，
    // 挖掉会把问题改坏。
    const parsed = parseMentions("这段请 @吴二 复核一下", ["吴二"]);
    expect(parsed.instruction).toBe("这段请 @吴二 复核一下");
  });

  it("开头点名照旧被挖掉", () => {
    const parsed = parseMentions("@吴二 复核一下", ["吴二"]);
    expect(parsed.instruction).toBe("复核一下");
    expect(parsed.named).toEqual(["吴二"]);
  });

  it("开头和句中一起出现，两个人都问", () => {
    const parsed = parseMentions("@吴二 你和 @王四 对一下", ["吴二", "王四"]);
    expect(parsed.named).toEqual(["吴二", "王四"]);
  });

  it("句中不认识的 @ 不算错", () => {
    // 「联系我 @公司邮箱」是正常写作。把它当成打错的名字来拦，
    // 输入框就没法写正常的句子了。
    const parsed = parseMentions("发到 @公司邮箱 那边", ["吴二"]);
    expect(parsed.unknown).toEqual([]);
    expect(parsed.named).toEqual([]);
  });

  it("句中的名字也要卡边界", () => {
    // 没有边界判断，「@架构师」会命中「架构」，问题就发给了另一个人。
    const parsed = parseMentions("找 @架构师 看看", ["架构", "架构师"]);
    expect(parsed.named).toEqual(["架构师"]);
  });
});
