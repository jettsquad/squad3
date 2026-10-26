// 移植自 Squad 2.x packages/seat-dsh/test/patch.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import {
  buildDshPatch,
  COMPAT_API_KEY_ENV,
  COMPAT_ROUTE,
  DELEGATION_PLUGINS,
  delegationOffRows,
  isDeepSeekModel,
  isDeepSeekPublicEndpoint,
} from "../src/main/seats/dsh/patch.ts";

describe("buildDshPatch", () => {
  it("没配模型就不写 patch", () => {
    // profile 自己的设置就是答案；再写一遍就是同一个决定有了第二个住处。
    expect(buildDshPatch({ model: "", baseUrl: "https://x" })).toBeUndefined();
    expect(buildDshPatch({ model: "   ", baseUrl: "" })).toBeUndefined();
  });

  it("非 DeepSeek 的模型走兼容 provider，并且带上端点", () => {
    // 这就是那个 bug：不写 patch 的话，MiniMax 的 key 会被发去 DeepSeek 的
    // 官方端点，然后报「key 无效」——怪罪的是 key，而请求根本发错了公司。
    const patch = buildDshPatch({ model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1" })!;
    expect(patch).toContain(COMPAT_ROUTE);
    expect(patch).toContain('baseURL: "https://api.minimaxi.com/v1"');
    expect(patch).toContain('- id: "MiniMax-M3"');
    expect(patch).toContain("llm-pi-ai");
  });

  it("DeepSeek 的模型走它自己的 provider", () => {
    const patch = buildDshPatch({ model: "deepseek-v4-pro", baseUrl: "https://gateway.example.com/deepseek" })!;
    expect(patch).toContain("provider: deepseek-official");
    expect(patch).toContain("llm-deepseek");
    expect(patch).not.toContain(COMPAT_ROUTE);
  });

  it("DeepSeek 模型没给端点就不覆盖端点", () => {
    const patch = buildDshPatch({ model: "deepseek-chat", baseUrl: "" })!;
    expect(patch).not.toContain("llm-deepseek");
    expect(patch).toContain('model: "deepseek-chat"');
  });

  it("密钥永远不进 patch 文件，只进变量名", () => {
    // patch 是磁盘上的文件，写进去的密钥会活得比这一次运行更久。
    const patch = buildDshPatch({ model: "MiniMax-M3", baseUrl: "https://x" })!;
    expect(patch).toContain(`apiKeyEnv: ${COMPAT_API_KEY_ENV}`);
    expect(patch).not.toMatch(/sk-|apiKey:\s*"/);
  });
});

describe("isDeepSeekModel", () => {
  it("按前缀分流，大小写不敏感", () => {
    expect(isDeepSeekModel("deepseek-chat")).toBe(true);
    expect(isDeepSeekModel("DeepSeek-V4")).toBe(true);
    expect(isDeepSeekModel("MiniMax-M3")).toBe(false);
    expect(isDeepSeekModel("")).toBe(false);
  });
});

describe("delegationOffRows", () => {
  it("把 headless 剖面里能派生子 agent 的插件全部标成 disabled", () => {
    // 六个都要关：subagent / subagent_fork 直接派，ralph 和 workflow 拿子 agent
    // 当工人，剩下两个是管理它们的工具。漏一个，围栏就有一个缺口。
    const rows = delegationOffRows().join("\n");
    for (const id of DELEGATION_PLUGINS) {
      expect(rows).toContain(`- id: ${id}\n  disabled: true`);
    }
    expect(DELEGATION_PLUGINS).toHaveLength(6);
  });
});

describe("DeepSeek 官方地址交给 dsh 自己定", () => {
  it("连接里填的是官方地址，就不往 patch 里写 baseURL", () => {
    // 真实发生的：连接存的是 https://api.deepseek.com（0.1.x 的 chat/completions 用它），
    // dsh 升到 0.2 后改走 Messages API，官方地址成了 …/anthropic。原样传进去拼出
    // …/v1/messages，用 DeepSeek 自家模型的席位全部 404。
    for (const endpoint of ["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1"]) {
      const patch = buildDshPatch({ model: "deepseek-v4-pro", baseUrl: endpoint })!;
      expect(patch, endpoint).not.toContain("baseURL");
      expect(patch).toContain('model: "deepseek-v4-pro"');
    }
  });

  it("思考强度照样带上", () => {
    const patch = buildDshPatch({ model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com", effort: "high" })!;
    expect(patch).toContain("reasoningEffort: high");
    expect(patch).not.toContain("baseURL");
  });

  it("网关和别的路径原样传", () => {
    const gateway = buildDshPatch({ model: "deepseek-v4-pro", baseUrl: "https://gw.example.com/v1" })!;
    expect(gateway).toContain('baseURL: "https://gw.example.com/v1"');
    // 人已经明确写了新路径，那就是他要的。
    const explicit = buildDshPatch({ model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/anthropic" })!;
    expect(explicit).toContain('baseURL: "https://api.deepseek.com/anthropic"');
  });

  it("兼容线路上的模型不受影响", () => {
    const patch = buildDshPatch({ model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1" })!;
    expect(patch).toContain('baseURL: "https://api.minimaxi.com/v1"');
  });

  it("认得出官方地址的几种写法，认不出的不乱认", () => {
    expect(isDeepSeekPublicEndpoint("https://api.deepseek.com")).toBe(true);
    expect(isDeepSeekPublicEndpoint(" https://api.deepseek.com/v1/ ")).toBe(true);
    expect(isDeepSeekPublicEndpoint("https://api.deepseek.com/anthropic")).toBe(false);
    expect(isDeepSeekPublicEndpoint("https://api.deepseek.com.evil.example/v1")).toBe(false);
    expect(isDeepSeekPublicEndpoint("")).toBe(false);
  });
});
