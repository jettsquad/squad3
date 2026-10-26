// 移植自 Squad 2.x packages/seat-claude-code/test/stream-fallback.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { readStream } from "../src/main/seats/claude-code/stream.ts";

const line = (o: unknown) => JSON.stringify(o);
const assistant = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });

describe("readStream 的回退", () => {
  it("有事件但没等到 result：答复是已经到手的助手文本", () => {
    const raw = [line({ type: "system", subtype: "init" }), assistant("先说一句")].join("\n");
    expect(readStream(raw)).toMatchObject({ text: "先说一句", failed: true });
  });

  it("有事件、连一句助手文本都没有：空答复，绝不把日志当答复", () => {
    // 这是那个 bug：CLI 明明在讲 stream-json，只是被看门狗杀在了 result 之前，
    // 而整坨 JSONL 被当成「席位说的话」写进了讨论记录。
    const raw = [
      line({ type: "system", subtype: "init", tools: ["Bash", "Read"] }),
      line({ type: "system", subtype: "api_retry", attempt: 3, error: "authentication_failed" }),
    ].join("\n");
    const got = readStream(raw);
    expect(got.text).toBe("");
    expect(got.failed).toBe(true);
    expect(got.text).not.toContain("api_retry");
  });

  it("一个事件都没有：那才是纯文本，原样当答复", () => {
    // 老版本 CLI，或者在 stream-json 开始之前就失败了。
    expect(readStream("就是一句普通输出")).toMatchObject({ text: "就是一句普通输出", failed: false });
  });

  it("空输出算失败", () => {
    expect(readStream("   ")).toMatchObject({ text: "", failed: true });
  });
});
