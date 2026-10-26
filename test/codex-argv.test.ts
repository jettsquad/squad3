// 移植自 Squad 2.x packages/seat-codex/test/argv.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { buildCodexArgv, isCodexMode } from "../src/main/seats/codex/argv.ts";

const base = { prompt: "做点事", cwd: "/p" };

describe("buildCodexArgv", () => {
  it("headless 入口 + 目录 + JSONL", () => {
    const argv = buildCodexArgv(base);
    expect(argv.slice(0, 5)).toEqual(["exec", "--cd", "/p", "--json", "--skip-git-repo-check"]);
  });

  it("--skip-git-repo-check 永远在", () => {
    // 没有它，codex 在任何不在信任列表里的目录都拒绝启动，报的是
    // 「Not inside a trusted directory」——跟人做过的事对不上。
    for (const mode of ["read-only", "workspace", "yolo"] as const) {
      expect(buildCodexArgv({ ...base, permissionMode: mode })).toContain("--skip-git-repo-check");
    }
  });

  it("权限走 -c approval_policy，不走 --ask-for-approval", () => {
    // 后者是顶层 flag，`codex exec` 会以 unexpected argument 拒掉。
    const argv = buildCodexArgv({ ...base, permissionMode: "read-only" });
    expect(argv).toContain("-c");
    expect(argv).toContain("approval_policy=never");
    expect(argv).not.toContain("--ask-for-approval");
  });

  it("三种模式各不相同", () => {
    expect(buildCodexArgv({ ...base, permissionMode: "read-only" })).toContain('sandbox_mode="read-only"');
    expect(buildCodexArgv({ ...base, permissionMode: "workspace" })).toContain('sandbox_mode="workspace-write"');
    expect(buildCodexArgv({ ...base, permissionMode: "yolo" })).toContain("--dangerously-bypass-approvals-and-sandbox");
    // yolo 绕开两个轴，所以不该再带 sandbox。
    expect(buildCodexArgv({ ...base, permissionMode: "yolo" }).join(" ")).not.toContain("sandbox_mode");
  });

  it("沙箱走 -c，不走 --sandbox", () => {
    // 两个入口吃的参数不一样：`codex exec` 有 --sandbox，`codex exec resume`
    // 没有，传过去整个 run 以「unexpected argument」失败。-c 两边都认。
    for (const argv of [buildCodexArgv(base), buildCodexArgv({ ...base, resumeSessionId: "t1" })]) {
      expect(argv).not.toContain("--sandbox");
      expect(argv).toContain('sandbox_mode="workspace-write"');
    }
  });

  it("不给模式就是 workspace", () => {
    expect(buildCodexArgv(base)).toContain('sandbox_mode="workspace-write"');
  });

  it("勾了联网才打开沙箱的出网通道", () => {
    // codex 的沙箱默认是关的：只给 --sandbox workspace-write，里面的 curl
    // 连都连不上（实测 0.153.4，curl 直接 exit 7）。加上这个 -c 之后同一条
    // curl 返回 200。这是「允许联网」对 codex 席位唯一起作用的地方。
    expect(buildCodexArgv({ ...base, webAccess: true })).toContain("sandbox_workspace_write.network_access=true");
  });

  it("没勾联网就不开出网通道", () => {
    for (const argv of [buildCodexArgv(base), buildCodexArgv({ ...base, webAccess: false })]) {
      expect(argv.join(" ")).not.toContain("network_access");
    }
  });

  it("web_search 两个方向都明写，不看宿主的 config.toml 脸色", () => {
    // 这两个键宿主的 ~/.codex/config.toml 里也能设。宿主要是在那儿把
    // tools.web_search 打开了，一个没勾联网、提示词还写着「你没有搜索工具」
    // 的席位就会凭空多出一个搜索工具——所以关的那一侧也要明写成 false，
    // 让席位的命令行成为唯一答案。
    expect(buildCodexArgv({ ...base, webAccess: true })).toContain("tools.web_search=true");
    expect(buildCodexArgv({ ...base, webAccess: false })).toContain("tools.web_search=false");
    expect(buildCodexArgv(base)).toContain("tools.web_search=false");
  });

  it("只写给真正读它的那个模式", () => {
    // read-only 没有可写沙箱给这个键去配，yolo 整个绕开沙箱——两种情况下
    // 写上去都是一句 CLI 不会照做的话。
    expect(buildCodexArgv({ ...base, permissionMode: "read-only", webAccess: true }).join(" ")).not.toContain(
      "network_access",
    );
    expect(buildCodexArgv({ ...base, permissionMode: "yolo", webAccess: true }).join(" ")).not.toContain(
      "network_access",
    );
  });

  it("提示词是最后一个、且是一个参数", () => {
    // 它是带换行和引号的用户文本。拼成 shell 字符串就是一个以团队讨论
    // 为载荷的命令注入洞。
    const argv = buildCodexArgv({ ...base, prompt: '第一行\n第二行 "引号"' });
    expect(argv[argv.length - 1]).toBe('第一行\n第二行 "引号"');
    expect(argv.filter((a) => a.includes("第二行"))).toHaveLength(1);
  });

  it("模型和推理档位只在给了的时候出现", () => {
    expect(buildCodexArgv(base)).not.toContain("--model");
    expect(buildCodexArgv({ ...base, model: "gpt-5" })).toContain("gpt-5");
    expect(buildCodexArgv({ ...base, model: "   " })).not.toContain("--model");
    expect(buildCodexArgv({ ...base, reasoningEffort: "high" })).toContain('model_reasoning_effort="high"');
  });
});

describe("isCodexMode", () => {
  it("认自己的三个，不认 claude 的", () => {
    // 表单里换后端时若没重置，plan 会原样交给子进程，报错来自 CLI。
    expect(isCodexMode("workspace")).toBe(true);
    expect(isCodexMode("plan")).toBe(false);
    expect(isCodexMode(undefined)).toBe(false);
  });
});

describe("自定义端点", () => {
  it("没给端点就不声明 provider", () => {
    // 订阅席位用 CLI 自己的登录态和 provider；多声明一个就是覆盖掉它。
    expect(buildCodexArgv(base).join(" ")).not.toContain("model_providers");
  });

  it("给了端点就声明成一次性的 provider", () => {
    // 这是那个 bug：codex 没有 base-url 环境变量，不声明的话连接上的地址
    // 存得下、库里画得出、然后被忽略——和 dsh 那次一模一样。
    const argv = buildCodexArgv({ ...base, endpoint: "https://api.example.com/v1" });
    expect(argv).toContain('model_provider="squad"');
    expect(argv).toContain('model_providers.squad.base_url="https://api.example.com/v1"');
  });

  it("密钥只给变量名，不给值", () => {
    // 参数列表 ps 谁都看得见。
    const argv = buildCodexArgv({ ...base, endpoint: "https://x" });
    expect(argv).toContain('model_providers.squad.env_key="CODEX_API_KEY"');
    expect(argv.join(" ")).not.toMatch(/sk-|secret/);
  });

  it("wire_api 只能是 responses", () => {
    // 这个 CLI 已经明确拒绝 "chat"（no longer supported）。这是对「哪些网关
    // 能给 codex 席位用」的真实约束：只讲 chat-completions 的不行。
    expect(buildCodexArgv({ ...base, endpoint: "https://x" })).toContain('model_providers.squad.wire_api="responses"');
  });

  it("空白端点当没给", () => {
    expect(buildCodexArgv({ ...base, endpoint: "   " }).join(" ")).not.toContain("model_providers");
  });
});

describe("续接已有 thread", () => {
  it("resume 是子命令，不是标志", () => {
    // `codex exec resume <id>`——和 Claude 那边 `--resume <id>` 的形状不同，
    // 位置错了 CLI 会当成 prompt 收下。
    const argv = buildCodexArgv({ ...base, resumeSessionId: "01a08-thread" });
    expect(argv.slice(0, 3)).toEqual(["exec", "resume", "01a08-thread"]);
    expect(argv).toContain("--json");
    expect(argv).toContain("--skip-git-repo-check");
  });

  it("续接时不带 --cd —— resume 不认它", () => {
    // 这条是补的：漏了它，每隔一轮就有一个席位以「unexpected argument '--cd'」
    // 失败。失败会丢掉存下的会话 id，下一轮开新线程就正常，那一轮又存下 id，
    // 再下一轮又挂——症状是「发一次报错、再发一次就好」，来回反复。
    //
    // 不带也不丢东西：子进程本来就是在团队文件夹里起的，而 resume 的线程
    // 记着自己当初的目录。
    const argv = buildCodexArgv({ ...base, resumeSessionId: "t1" });
    expect(argv).not.toContain("--cd");
    expect(buildCodexArgv(base)).toContain("--cd");
  });

  it("续接时只用 resume 认得的参数", () => {
    // `codex exec resume --help` 列出来的那些。多一个就是整轮失败。
    const allowed = new Set([
      "-c",
      "--last",
      "--all",
      "--enable",
      "--disable",
      "-i",
      "--image",
      "--strict-config",
      "-m",
      "--model",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "--thread-source",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--output-schema",
      "--json",
      "-o",
      "--output-last-message",
    ]);
    for (const mode of ["read-only", "workspace", "yolo"] as const) {
      const argv = buildCodexArgv({ ...base, resumeSessionId: "t1", permissionMode: mode, webAccess: true });
      // 前三个是 exec / resume / <id>，最后一个是提示词。
      for (const token of argv.slice(3, -1)) {
        if (token.startsWith("-"))
          expect({ mode, token, allowed: allowed.has(token) }).toEqual({ mode, token, allowed: true });
      }
    }
  });

  it("不续接时形状一个字不变", () => {
    // 存量行为必须逐字保持：没有会话 id 的席位走的还是原来那条路。
    expect(buildCodexArgv(base).slice(0, 2)).toEqual(["exec", "--cd"]);
    expect(buildCodexArgv({ ...base, resumeSessionId: "" }).slice(0, 2)).toEqual(["exec", "--cd"]);
  });

  it("续接时提示词仍然是最后一个参数", () => {
    const argv = buildCodexArgv({ ...base, resumeSessionId: "t1" });
    expect(argv[argv.length - 1]).toBe(base.prompt);
  });
});

describe("派生子 agent", () => {
  // codex 的 multi_agent 是 stable、默认开着的。不写这个参数，席位就能自己
  // 派一队子 agent 去干活，桌上谁都看不见。
  const pair = (argv: readonly string[], value: string): boolean =>
    argv.some((arg, index) => arg === "-c" && argv[index + 1] === value);

  it("默认关掉，新开和续接两条命令行都关", () => {
    for (const argv of [buildCodexArgv(base), buildCodexArgv({ ...base, resumeSessionId: "t1" })]) {
      expect(pair(argv, "features.multi_agent=false")).toBe(true);
      expect(pair(argv, "features.multi_agent_v2=false")).toBe(true);
    }
  });

  it("创建时允许了才打开，而且明确写成 true，不交给本机配置决定", () => {
    const argv = buildCodexArgv({ ...base, subagents: true });
    expect(pair(argv, "features.multi_agent=true")).toBe(true);
    expect(argv).not.toContain("features.multi_agent=false");
  });

  it("提示词仍然是最后一个参数", () => {
    const argv = buildCodexArgv({ ...base, subagents: false });
    expect(argv[argv.length - 1]).toBe(base.prompt);
  });
});
