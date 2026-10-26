// 移植自 Squad 2.x packages/seat-dsh/test/dsh.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { buildDshArgv } from "../src/main/seats/dsh/argv.ts";
import { readDshOutput } from "../src/main/seats/dsh/stream.ts";

describe("buildDshArgv", () => {
  it("profile + 一个参数的提示词", () => {
    // `dsh --profile headless` 会把多个词用空格连起来，拆开传就会把
    // 席位提示词里承重的换行悄悄压平。
    const argv = buildDshArgv({ prompt: "第一行\n第二行", profile: "headless" });
    expect(argv).toEqual(["--profile", "headless", "第一行\n第二行"]);
  });

  it("profile 可换", () => {
    expect(buildDshArgv({ prompt: "x", profile: "seats" })[1]).toBe("seats");
  });
});

describe("readDshOutput", () => {
  it("纯文本直接就是答复", () => {
    expect(readDshOutput("  答复在这里  ")).toMatchObject({ text: "答复在这里", failed: false });
  });

  it("空输出算失败", () => {
    expect(readDshOutput("").failed).toBe(true);
    expect(readDshOutput("\n \n").failed).toBe(true);
  });

  it("没有用量，而不是零用量", () => {
    // headless 只打印最终消息，没有账目。报 0 会读成「便宜」而不是「没计量」。
    expect(readDshOutput("答复").usage).toBeUndefined();
  });
});

describe("readDshOutput 的用量", () => {
  it("从 stderr 读出来，放进 usage", () => {
    const out = readDshOutput(
      "这是答复。",
      '[squad-usage] {"inputTokens":1200,"outputTokens":80,"cacheReadTokens":300,"cacheCreationTokens":40}',
    );
    expect(out.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 300,
      cacheCreationTokens: 40,
    });
  });

  it("没有 stderr 时 usage 是 undefined，不是零", () => {
    expect(readDshOutput("这是答复。").usage).toBeUndefined();
  });

  it("失败的一轮也要带上已经花掉的", () => {
    // 烧了 token 然后报错，仍然花了它花掉的那些。丢掉会让失败看起来免费。
    const out = readDshOutput("", '[squad-usage] {"inputTokens":500,"outputTokens":0}');
    expect(out.failed).toBe(true);
    expect(out.usage?.inputTokens).toBe(500);
  });
});
