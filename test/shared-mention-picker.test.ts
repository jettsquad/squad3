// 移植自 Squad 2.x packages/console/test/mention-picker.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { applyMention, mentionCandidates, mentionDraftAt, parseMentions } from "../src/shared/mention.ts";

const seats = ["架构师", "架构组", "王四", "吴二"];

describe("@ 名单浮层", () => {
  it("刚敲下 @ 就给全部成员", () => {
    const draft = mentionDraftAt("@", 1);
    expect(draft).toEqual({ at: 0, typed: "" });
    expect(mentionCandidates(draft!, seats)).toEqual(seats);
  });

  it("敲了几个字就按前缀筛，前缀匹配排前面", () => {
    const draft = mentionDraftAt("@架构", 3)!;
    expect(mentionCandidates(draft, seats)).toEqual(["架构师", "架构组"]);
  });

  it("空格之后就不是在点名了", () => {
    // 越过空格人已经在写正文；这时候还弹名单，选中就会把名字塞进句子里。
    expect(mentionDraftAt("@架构师 看看这个", 9)).toBeUndefined();
  });

  it("句子中间的 @ 也弹名单", () => {
    // 现在句子任何位置的 @名字 都会被点到（1.x 的规则），所以名单要跟着出现。
    expect(mentionDraftAt("请 @架构", 5)?.typed).toBe("架构");
  });

  it("第二个 @ 仍然算点名", () => {
    const draft = mentionDraftAt("@架构师 @王", 8);
    expect(draft?.typed).toBe("王");
  });

  it("选中后补一个空格，并把光标放在它后面", () => {
    // 没有这个空格，接着敲的字会长进名字里，parseMentions 就会报一个不存在的成员。
    const draft = mentionDraftAt("@架构", 3)!;
    const applied = applyMention("@架构", 3, draft, "架构师");
    expect(applied.text).toBe("@架构师 ");
    expect(applied.caret).toBe(5);
    expect(parseMentions(applied.text, seats).named).toEqual(["架构师"]);
  });

  it("选中不吃掉光标后面已经写好的正文", () => {
    const raw = "@架看看这个";
    const draft = mentionDraftAt(raw, 2)!;
    expect(applyMention(raw, 2, draft, "架构师").text).toBe("@架构师 看看这个");
  });
});
