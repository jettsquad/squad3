// 移植自 Squad 2.x packages/shared/test/speakable.test.ts @ 8e96d9c
/**
 * Every case here is something that is fine on screen and unbearable in an
 * ear: a code block read out symbol by symbol, a table read as a word stream,
 * hashes pronounced as "well well well".
 */
import { describe, expect, it } from "vitest";
import { credentialFrom, speakableText, speechChunks } from "../src/shared/speakable.ts";
import { defaultVoiceFor, languageBoostFor, voiceLabel } from "../src/shared/voices.ts";

describe("speakableText", () => {
  it("names a code block instead of reading it", () => {
    const spoken = speakableText("先看这段：\n```ts\nconst a = 1;\n```\n就这样。");
    expect(spoken).toContain("这里有一段代码");
    expect(spoken).not.toContain("const");
  });

  it("keeps inline code, because it is usually one word", () => {
    // 「反引号 seatId 反引号」 is worse than just saying seatId.
    expect(speakableText("改 `seatId` 就行")).toBe("改 seatId 就行");
  });

  it("announces a table with its size rather than reading the cells", () => {
    // Read aloud, a table becomes a stream of words with no structure — the
    // one thing a table exists to provide.
    const spoken = speakableText("对比：\n| 方案 | 代价 |\n| --- | --- |\n| A | 慢 |\n| B | 贵 |\n完。");
    expect(spoken).toContain("这里有一个表格");
    expect(spoken).not.toContain("---");
    expect(spoken).not.toContain("|");
  });

  it("turns headings into spoken transitions", () => {
    expect(speakableText("## 结论\n可以做。")).toBe("。结论。\n可以做。");
  });

  it("drops list markers and emphasis, keeps the words", () => {
    const spoken = speakableText("- **重要**：别忘了\n- 第二条");
    expect(spoken).not.toContain("*");
    expect(spoken).toContain("重要");
    expect(spoken).toContain("第二条");
  });

  it("says the link text and never the URL", () => {
    expect(speakableText("见[文档](https://example.com/a/b)")).toBe("见文档");
  });
});

describe("speechChunks", () => {
  it("cuts at sentence ends, not at a character count", () => {
    // A cut mid-clause is audible, and sounds like the thing broke.
    const text = `${"一".repeat(300)}。${"二".repeat(300)}。${"三".repeat(300)}。`;
    const chunks = speechChunks(text, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.endsWith("。")).toBe(true);
  });

  it("keeps one over-long sentence whole rather than cutting inside it", () => {
    const text = `${"长".repeat(900)}。`;
    expect(speechChunks(text, 400)).toHaveLength(1);
  });

  it("answers nothing for nothing", () => {
    expect(speechChunks("   ")).toEqual([]);
  });
});

describe("credentialFrom", () => {
  it("finds the token whichever variable it landed in", () => {
    // Which one it is depends on the backend and, for Claude Code, on the
    // auth header. A caller re-deriving that rule gets one case wrong.
    expect(credentialFrom({ ANTHROPIC_AUTH_TOKEN: "t" })).toBe("t");
    expect(credentialFrom({ DEEPSEEK_API_KEY: "d" })).toBe("d");
    expect(credentialFrom({ ANTHROPIC_BASE_URL: "https://x" })).toBeUndefined();
  });
});

describe("defaultVoiceFor", () => {
  it("同一个名字永远是同一个声音", () => {
    // Stability is the whole point: a member whose voice changed between
    // rounds would be unfollowable by ear, which is what the feature is for.
    expect(defaultVoiceFor("吴二")).toBe(defaultVoiceFor("吴二"));
  });

  it("一桌人里大多能分开", () => {
    // Not a guarantee — with 16 voices and 6 seats a collision is possible —
    // but a table where everyone lands on one voice would be useless, and
    // that is what a bad hash would produce.
    const roster = ["吴二", "王四", "郑三", "陈六", "周一", "冯五"];
    expect(new Set(roster.map(defaultVoiceFor)).size).toBeGreaterThanOrEqual(4);
  });

  it("不认识的音色 id 按原样显示，不冒充成别的", () => {
    expect(voiceLabel("some-cloned-voice")).toBe("some-cloned-voice");
    expect(voiceLabel("Chinese (Mandarin)_Gentleman")).toBe("温润男声");
  });
});

describe("公式念成英文词", () => {
  it("下标、根号、希腊字母都变成词", () => {
    // 不转的话送进合成器的是「美元 v 下划线 左花括号……」，而中间那串孤立的
    // 拉丁字母正是语言检测猜成德语的依据。
    const out = speakableText("由此可得 $v_{max} = \\sqrt{2gh}$。");
    expect(out).toContain("v sub max");
    expect(out).toContain("equals");
    expect(out).toContain("square root of");
    expect(out).not.toContain("$");
    expect(out).not.toContain("\\");
    expect(out).not.toContain("{");
  });

  it("行间公式和分式", () => {
    const out = speakableText("误差满足 $$\\frac{\\Delta x}{x} \\leq \\epsilon^2$$ 这个界。");
    expect(out).toContain("over");
    expect(out).toContain("less than or equal to");
    expect(out).toContain("squared");
    expect(out).toContain("Delta");
  });

  it("裸的希腊字母也要命名", () => {
    // 没有 $ 包起来的 σ 一样是孤立字形，一样会被检测器拿去猜。
    const out = speakableText("设 α 为学习率，σ 为标准差。");
    expect(out).toContain("alpha");
    expect(out).toContain("sigma");
    expect(out).not.toContain("α");
    expect(out).not.toContain("σ");
  });

  it("价格不是公式", () => {
    // 两个不相干的美元号之间整句被当成公式吃掉，是这条规则最容易犯的错。
    const out = speakableText("这本书卖 $30，比原价 $45 便宜。");
    expect(out).toContain("$30");
    expect(out).toContain("$45");
    expect(out).toContain("比原价");
  });

  it("中文散文原样保留", () => {
    const out = speakableText("这一段没有公式，应该一个字都不动。");
    expect(out).toBe("这一段没有公式，应该一个字都不动。");
  });
});

describe("languageBoostFor", () => {
  it("按音色定，德语不在候选里", () => {
    expect(languageBoostFor("Chinese (Mandarin)_Gentleman")).toBe("Chinese");
    expect(languageBoostFor("English_Trustworthy_Man")).toBe("English");
  });

  it("表里没有的 id 按 MiniMax 自己的命名判断", () => {
    // 手填的音色不该悄悄落到错的语言上。
    expect(languageBoostFor("English_Some_New_Voice")).toBe("English");
    expect(languageBoostFor("Chinese (Mandarin)_Whatever")).toBe("Chinese");
  });
});
