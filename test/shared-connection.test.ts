// 移植自 Squad 2.x packages/shared/test/connection.test.ts @ 8dcb903
/**
 * The injection rule is the only real difference between the two auth modes,
 * and the direction it fails in is "something was sent that should not have
 * been". So it lives in one function and is checked from both sides.
 */
import { describe, expect, it } from "vitest";
import { connectionMismatch } from "../src/shared/agent-template.ts";
import {
  credentialRefFor,
  modelArgumentFor,
  capExceeded,
  checkConnection,
  envForConnection,
  isOwnModel,
  liveConnection,
  meaningfulCaps,
  type SeatConnection,
} from "../src/shared/connection.ts";

const subscription = (over: Partial<SeatConnection> = {}): SeatConnection => ({
  connectionId: "c1",
  displayName: "本机登录",
  authMode: "subscription",
  backend: "claude-code",
  ...over,
});

const apiKey = (over: Partial<SeatConnection> = {}): SeatConnection => ({
  connectionId: "c2",
  displayName: "自建网关",
  authMode: "api-key",
  backend: "claude-code",
  endpoint: "https://gateway.example/v1",
  credentialRef: "GATEWAY_KEY",
  modelId: "deepseek-chat",
  ...over,
});

describe("envForConnection · subscription", () => {
  it("injects nothing at all by default", () => {
    // 1.x's executor says it in capitals: MUST NOT inject an auth token. The
    // seat uses the human's own CLI login, and anything injected would
    // silently authenticate as something else.
    expect(envForConnection(subscription(), "a-secret")).toEqual({});
  });

  it("never sends a token even when one is available", () => {
    expect(envForConnection(subscription({ modelId: "sonnet" }), "a-secret")).toEqual({
      ANTHROPIC_MODEL: "sonnet",
    });
  });

  it("passes a model the login can actually serve", () => {
    expect(envForConnection(subscription({ modelId: "opus" }))).toHaveProperty("ANTHROPIC_MODEL", "opus");
  });

  it("withholds a foreign model rather than letting it 404 confusingly", () => {
    // Sent to the login's own endpoint, a foreign name comes back as an error
    // about the model — and the person goes looking at the model.
    expect(envForConnection(subscription({ modelId: "deepseek-chat" }))).toEqual({});
  });
});

describe("envForConnection · api-key", () => {
  it("sends endpoint, token and model together", () => {
    expect(envForConnection(apiKey(), "sk-live")).toEqual({
      ANTHROPIC_BASE_URL: "https://gateway.example/v1",
      ANTHROPIC_API_KEY: "sk-live",
      ANTHROPIC_MODEL: "deepseek-chat",
    });
  });

  it("accepts any model name, because it travels with its own endpoint", () => {
    // The namespace guard is a subscription-mode concern only.
    expect(envForConnection(apiKey({ modelId: "whatever-v9" }), "sk")).toHaveProperty("ANTHROPIC_MODEL", "whatever-v9");
  });

  it("omits the token when the credential could not be resolved", () => {
    // Rather than sending an empty one, which authenticates as nobody and
    // fails with a message about the request instead of about the key.
    expect(envForConnection(apiKey(), undefined)).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
});

describe("checkConnection", () => {
  it("accepts both ordinary shapes", () => {
    expect(checkConnection(subscription())).toEqual([]);
    expect(checkConnection(apiKey())).toEqual([]);
  });

  it("refuses an endpoint on a subscription rather than ignoring it", () => {
    // A stored setting that never takes effect is one the person believes is
    // in force.
    expect(checkConnection(subscription({ endpoint: "https://x" }))[0]?.detail).toMatch(/不使用自定义端点/);
  });

  it("refuses a foreign model on a subscription, and says why", () => {
    const problems = checkConnection(subscription({ modelId: "deepseek-chat" }));
    expect(problems[0]?.detail).toMatch(/报出来的错会指向模型/);
  });

  it("requires a credential reference in api-key mode", () => {
    expect(checkConnection(apiKey({ credentialRef: "" }))[0]?.detail).toMatch(/凭据名/);
  });
});

describe("isOwnModel", () => {
  it("knows each backend's own families", () => {
    expect(isOwnModel("claude-code", "sonnet")).toBe(true);
    expect(isOwnModel("codex", "gpt-5")).toBe(true);
    expect(isOwnModel("dsh", "deepseek-chat")).toBe(true);
    expect(isOwnModel("claude-code", "gpt-5")).toBe(false);
  });
});

describe("caps", () => {
  it("drops the cost ceiling for a subscription seat", () => {
    // It bills nothing, so a cost cap can never fire. Offering the field
    // would be offering a knob a person sets and then relies on.
    expect(meaningfulCaps("subscription")).not.toContain("maxCostUsd");
    expect(meaningfulCaps("api-key")).toContain("maxCostUsd");
  });

  it("binds a subscription seat by turns", () => {
    expect(capExceeded({ maxTurns: 3 }, { turns: 3, tokens: 0 }, "subscription")).toMatch(/轮数上限/);
  });

  it("ignores a cost cap set on a subscription seat", () => {
    // Stored but inert; reporting it as exceeded would stop a seat for a
    // reason that cannot be true.
    expect(capExceeded({ maxCostUsd: 1 }, { turns: 0, tokens: 0, costUsd: 99 }, "subscription")).toBeUndefined();
  });

  it("binds an api-key seat by cost", () => {
    expect(capExceeded({ maxCostUsd: 1 }, { turns: 0, tokens: 0, costUsd: 1.5 }, "api-key")).toMatch(/花费上限/);
  });

  it("says nothing when nothing is capped", () => {
    expect(capExceeded({}, { turns: 999, tokens: 999_999, costUsd: 99 }, "api-key")).toBeUndefined();
  });
});

describe("credentialRefFor", () => {
  it("生成的是合法的 POSIX 标识符", () => {
    // dsh 把 ref 品牌化成 shell 标识符；带连字符的连接 id 直接拿去用是不合法的。
    expect(credentialRefFor("conn-a1")).toBe("SQUAD_CONN_A1_KEY");
    expect(credentialRefFor("gw.example/v1")).toBe("SQUAD_GW_EXAMPLE_V1_KEY");
    for (const id of ["conn-a1", "x", "a--b__c", "中文", "9lives"]) {
      expect(credentialRefFor(id)).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    }
  });

  it("不同连接不会撞名", () => {
    // 撞名意味着改了一个连接的 key，另一个连接的 key 也跟着变了，而且不报错。
    const names = new Set(["conn-1", "conn-2", "gw", "login"].map(credentialRefFor));
    expect(names.size).toBe(4);
  });

  it("带 SQUAD_ 前缀，避开人自己导出的变量", () => {
    // credentials.set 在只读来源遮蔽同名引用时会拒绝写入。撞上 shell 里
    // export 过的 ANTHROPIC_API_KEY，粘 key 就会失败，报的还是遮蔽的错。
    expect(credentialRefFor("anthropic-api")).not.toBe("ANTHROPIC_API_KEY");
    expect(credentialRefFor("anything").startsWith("SQUAD_")).toBe(true);
  });

  it("空的也给得出名字，而不是一个孤零零的下划线", () => {
    expect(credentialRefFor("")).toBe("SQUAD_CONNECTION_KEY");
    expect(credentialRefFor("---")).toBe("SQUAD_CONNECTION_KEY");
  });
});

describe("envForConnection：每个后端读的变量名不一样", () => {
  const of = (over: Partial<SeatConnection>): SeatConnection => ({
    connectionId: "c",
    displayName: "c",
    authMode: "api-key",
    backend: "claude-code",
    ...over,
  });

  it("codex 拿 CODEX_API_KEY，而不是 ANTHROPIC_*", () => {
    // 原来所有连接都发 ANTHROPIC_*：codex 席位拿到一堆它不读的变量、
    // 一个它要的都没有，然后以一个指不到任何地方的鉴权错误失败。
    const env = envForConnection(of({ backend: "codex", endpoint: "https://x", modelId: "gpt-5" }), "k");
    expect(env["CODEX_API_KEY"]).toBe("k");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  });

  it("codex 不从环境变量拿模型和端点", () => {
    // 模型走 --model 命令行参数，端点由 CLI 自己的配置管——这里发出去
    // 就是发一个没人读的设置。
    const env = envForConnection(of({ backend: "codex", endpoint: "https://x", modelId: "gpt-5" }), "k");
    expect(Object.keys(env)).toEqual(["CODEX_API_KEY"]);
  });

  it("dsh 拿 DEEPSEEK_API_KEY", () => {
    expect(envForConnection(of({ backend: "dsh" }), "k")["DEEPSEEK_API_KEY"]).toBe("k");
  });

  it("claude-code 三样照旧", () => {
    const env = envForConnection(of({ endpoint: "https://gw", modelId: "m" }), "k");
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://gw",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_MODEL: "m",
    });
  });

  it("订阅模式下，没有环境变量放模型的后端就什么都不发", () => {
    expect(envForConnection(of({ backend: "codex", authMode: "subscription", modelId: "gpt-5" }))).toEqual({});
  });
});

describe("modelArgumentFor", () => {
  const of = (over: Partial<SeatConnection>): SeatConnection => ({
    connectionId: "c",
    displayName: "c",
    authMode: "api-key",
    backend: "codex",
    ...over,
  });

  it("只有走命令行的后端才给", () => {
    // claude-code 用 ANTHROPIC_MODEL，再从命令行给一次就是说两遍。
    expect(modelArgumentFor(of({ backend: "claude-code", modelId: "m" }))).toBeUndefined();
    expect(modelArgumentFor(of({ modelId: "gpt-5" }))).toBe("gpt-5");
  });

  it("订阅模式下外来模型不给", () => {
    // 给了就会被发到登录态自己的端点，报出来的错指向模型而不是这个不匹配。
    expect(modelArgumentFor(of({ authMode: "subscription", modelId: "deepseek-chat" }))).toBeUndefined();
    expect(modelArgumentFor(of({ authMode: "subscription", modelId: "gpt-5" }))).toBe("gpt-5");
  });
});

describe("connectionMismatch", () => {
  it("后端一致就没问题", () => {
    expect(connectionMismatch("codex", "codex", "n")).toBeUndefined();
  });

  it("不一致要拒，而且说清楚两条路", () => {
    // 之前两边可以随便不一致，失败是彻底静默的：连接按它自己的后端注册
    // provider，于是 codex agent 去要 codex/<id>，而存在的是
    // claude-code-fenced/<id>。一轮跑起来才报，名字谁都没敲过。
    const detail = connectionMismatch("codex", "claude-code", "Team-MiniMax-H3");
    expect(detail).toContain("Team-MiniMax-H3");
    expect(detail).toContain("claude-code");
    expect(detail).toContain("codex");
  });
});

describe("authHeader：密钥放哪个头", () => {
  const of = (over: Partial<SeatConnection>): SeatConnection => ({
    connectionId: "c",
    displayName: "c",
    authMode: "api-key",
    backend: "claude-code",
    ...over,
  });

  it("默认走 x-api-key（ANTHROPIC_API_KEY）", () => {
    // MiniMax 的 Anthropic 兼容端点只认 X-Api-Key，连发 Bearer 都明确回
    // 「请把密钥放在 X-Api-Key 头里」。配成 Bearer 的连接会永远认证失败，
    // 而 CLI 会一直重试——报出来的错里一个字都不会提到「头」。
    expect(envForConnection(of({}), "k")["ANTHROPIC_API_KEY"]).toBe("k");
    expect(envForConnection(of({}), "k")["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
  });

  it("显式选 bearer 才走 ANTHROPIC_AUTH_TOKEN", () => {
    const env = envForConnection(of({ authHeader: "bearer" }), "k");
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("k");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("只有一个变量被设，不是两个都设", () => {
    // 两个都发就是让 CLI 替我们猜，而猜错的那次不会说自己猜了。
    expect(Object.keys(envForConnection(of({ endpoint: "https://x" }), "k")).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
    ]);
  });

  it("其它后端不受影响", () => {
    expect(envForConnection(of({ backend: "codex", authHeader: "bearer" }), "k")["CODEX_API_KEY"]).toBe("k");
    expect(envForConnection(of({ backend: "dsh", authHeader: "bearer" }), "k")["DEEPSEEK_API_KEY"]).toBe("k");
  });
});

describe("liveConnection", () => {
  const registered = { connectionId: "c1", modelId: "gpt-6.1-sol" };

  it("用连接现在的样子，不用注册时抓下来的那份", () => {
    // 真实发生过：连接的模型从 gpt-6.1-sol 改成了 gpt-6-sol，存储里也是新的，
    // 席位照旧报 gpt-6.1-sol 不支持——provider 注册一次、活到进程结束，它手里
    // 那份跟进程一样老。
    const edited = { connectionId: "c1", modelId: "gpt-6-sol" };
    expect(liveConnection(registered, () => edited)).toBe(edited);
  });

  it("查不到了就用注册时那份，让这一轮按自己的原因失败", () => {
    expect(liveConnection(registered, () => undefined)).toBe(registered);
  });

  it("没有连接的席位还是没有连接", () => {
    expect(liveConnection(undefined, () => registered)).toBeUndefined();
  });
});
