// 移植自 Squad 2.x packages/seat-runtime/test/failure.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { failureText } from "../src/main/seat-runtime/failure.ts";

describe("failureText", () => {
  it("stderr 是答案，就把 stderr 给出来", () => {
    // 这是那个 bug 的全部：每个 CLI 都把拒绝写在 stderr、把答复写在 stdout，
    // 而我们只读 stdout。于是席位红着「失败」两个字、一句话都不说，而理由
    // 就躺在一个我们早就收集了、从没打开过的缓冲区里。
    const text = failureText({
      stderr: 'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"',
      exitCode: 1,
    });
    expect(text).toContain("MISSING_CREDENTIAL");
    expect(text).toContain("没有给出答复");
  });

  it("解析器自己知道的原因排在前面", () => {
    const text = failureText({ detail: "配额用完了", stderr: "warn: something", exitCode: 1 });
    expect(text.indexOf("配额用完了")).toBeLessThan(text.indexOf("warn: something"));
  });

  it("什么都没有时，退出码也比沉默强", () => {
    expect(failureText({ stderr: "", exitCode: 137 })).toContain("137");
  });

  it("被信号杀掉和非零退出说的不是一回事", () => {
    // exitCode 为 null 意味着信号，不是干净退出。混为一谈会把一个被杀的
    // 席位读成一个正常结束的。
    expect(failureText({ stderr: "", exitCode: null })).toContain("信号");
    expect(failureText({ stderr: "", exitCode: null })).not.toContain("退出码");
  });

  it("空白的 stderr 不算内容", () => {
    expect(failureText({ stderr: "   \n  ", exitCode: 2 })).toContain("退出码 2");
  });
});
