// 移植自 Squad 2.x packages/shared/test/artifact-and-json.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { escapeStrayBackslashes, extractJsonObject } from "../src/shared/model-json.ts";
import { artifactText, touchedSince } from "../src/shared/team-artifact.ts";

describe("席位的回复写成文件时", () => {
  it("去掉给议程汇报用的【结果】行", () => {
    const reply = "第一章正文第一段。\n\n第二段。\n\n【结果】完成\n";
    expect(artifactText(reply)).toBe("第一章正文第一段。\n\n第二段。\n");
    expect(artifactText("没有汇报行")).toBe("没有汇报行\n");
    expect(artifactText("正文\n【结果】被卡住：缺东西")).toBe("正文\n");
  });

  it("席位自己写过的文件不能被回复覆盖", () => {
    const before = { mtimeMs: 100, size: 10 };
    // 文曲星用 Write 写了正文：文件时间和大小都变了。
    expect(touchedSince(before, { mtimeMs: 200, size: 6489 })).toBe(true);
    // 文件原本没有，这一轮出现了。
    expect(touchedSince(undefined, { mtimeMs: 200, size: 5 })).toBe(true);
    // 原样没动：该由程序写回复。
    expect(touchedSince(before, { mtimeMs: 100, size: 10 })).toBe(false);
    // 席位没写，文件也不存在：程序写。
    expect(touchedSince(undefined, undefined)).toBe(false);
  });
});

describe("模型 JSON 里的单反斜杠", () => {
  it("正则里的 \\. 不再让整份议程被拒", () => {
    // 真实出过的：王把 grep 的 0\.9 写进了 JSON 字符串。
    const text = String.raw`{"check":{"command":"grep -c \"0\.9\" f.md"}}`;
    expect(() => JSON.parse(text)).toThrow();
    const parsed = extractJsonObject(text, "没有对象") as { check: { command: string } };
    expect(parsed.check.command).toBe(String.raw`grep -c "0\.9" f.md`);
  });

  it("合法的转义原样保留，字符串外面不动", () => {
    const text = String.raw`{"a":"行一\n行二","b":"\"引号\"","c":"é","d":"路径\\x"}`;
    expect(escapeStrayBackslashes(text)).toBe(text);
    expect(extractJsonObject(text, "x")).toEqual({ a: "行一\n行二", b: '"引号"', c: "é", d: "路径\\x" });
  });

  it("\\u 后面不是四位十六进制就当作单反斜杠", () => {
    const text = String.raw`{"p":"C:\users\x"}`;
    expect(extractJsonObject(text, "x")).toEqual({ p: "C:\\users\\x" });
  });

  it("除了反斜杠之外的毛病照样报错", () => {
    expect(() => extractJsonObject('{"a":', "没有对象")).toThrow("没有对象");
    expect(() => extractJsonObject('{"a":1,}', "没有对象")).toThrow();
  });
});
