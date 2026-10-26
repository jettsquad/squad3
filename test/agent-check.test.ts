/**
 * 「测试」 on a library agent: five separate answers, a probe that really asks,
 * and nothing reading as a pass that did not run.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentCheck } from "../src/main/agent-check/index.ts";
import { createLibrary } from "../src/main/library/index.ts";
import type { SeatResult } from "../src/main/seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest, Seats } from "../src/main/seats/index.ts";
import { createVault, type Cipher } from "../src/main/vault/index.ts";
import { overallOf, type AgentTemplate } from "../src/shared/index.ts";

const cipher: Cipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(plain, "utf8"),
  decrypt: (sealed) => Buffer.from(sealed).toString("utf8"),
};

const agent = (over: Partial<AgentTemplate> = {}): AgentTemplate => ({
  templateId: "a1",
  displayName: "架构",
  role: "架构师",
  systemPrompt: "你负责结构。",
  backend: "claude-code",
  secretaryCandidate: true,
  color: "#534AB7",
  enabled: true,
  ...over,
});

interface Options {
  readonly answer?: (request: SeatRequest) => Promise<Partial<SeatResult>>;
  readonly missingCli?: boolean;
  readonly headFails?: boolean;
}

function setup(options: Options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-check-"));
  const library = createLibrary({ dataDir, vault: createVault({ dataDir, cipher, env: {} }) });
  const requests: SeatRequest[] = [];
  const adapter: SeatAdapter = {
    backend: "claude-code",
    capabilities: { persona: true, resume: true },
    locate: () => {
      if (options.missingCli === true) throw new Error("PATH 上找不到 claude。");
      return { file: "C:\\bin\\claude.exe", prefixArgs: [] };
    },
    start: (request) => {
      requests.push(request);
      const result = (async (): Promise<SeatResult> => ({
        text: "收到",
        failed: false,
        cancelled: false,
        exitCode: 0,
        durationMs: 1,
        ...(await (options.answer?.(request) ?? Promise.resolve({}))),
      }))();
      return { result, cancel: () => undefined };
    },
  };
  const seats: Seats = { adapterFor: (backend) => (backend === "claude-code" ? adapter : `没有「${backend}」后端。`) };
  const check = createAgentCheck({
    seats,
    library,
    probeTimeoutMs: 50,
    fetch: (async () => {
      if (options.headFails === true) throw new Error("HEAD timeout");
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  });
  return { library, check, requests };
}

const outcomes = (report: Awaited<ReturnType<ReturnType<typeof createAgentCheck>>>) =>
  Object.fromEntries(report.checks.map((one) => [one.name, one.outcome]));

describe("agent check", () => {
  it("a subscription agent: nothing to check is an answer, and the probe really asks — in a folder it then removes", async () => {
    const { library, check, requests } = setup();
    library.agents.save(agent());
    const report = await check("a1");
    expect(outcomes(report)).toEqual({
      席位后端: "ok",
      命令行工具: "ok",
      密钥: "skipped",
      地址可达: "skipped",
      真的问一句: "ok",
    });
    expect(overallOf(report)).toBe("ok");
    expect(requests[0]?.prompt).toMatch(/收到/);
    expect(existsSync(requests[0]?.cwd ?? "")).toBe(false);
  });

  it("an api-key agent with no key fails that check, and the probe is handed the connection", async () => {
    const { library, check, requests } = setup({ answer: async () => ({ failed: true, text: "invalid x-api-key" }) });
    library.connections.save({
      connectionId: "gw",
      displayName: "网关",
      authMode: "api-key",
      backend: "claude-code",
      endpoint: "https://gw.example.com",
    });
    library.agents.save(agent({ connectionId: "gw" }));
    const report = await check("a1");
    expect(outcomes(report)).toMatchObject({ 密钥: "fail", 地址可达: "ok", 真的问一句: "fail" });
    expect(report.checks.find((one) => one.name === "真的问一句")?.detail).toBe("invalid x-api-key");
    expect(requests[0]?.connection?.connection.connectionId).toBe("gw");
  });

  it("a connection of another backend fails ① and the probe is not started", async () => {
    const { library, check, requests } = setup();
    library.connections.save({
      connectionId: "cx",
      displayName: "codex 订阅",
      authMode: "subscription",
      backend: "codex",
    });
    library.agents.save(agent({ connectionId: "cx" }));
    const report = await check("a1");
    expect(outcomes(report)).toMatchObject({ 席位后端: "fail", 真的问一句: "unknown" });
    expect(requests).toEqual([]);
    expect(overallOf(report)).toBe("fail");
  });

  it("a missing CLI says where it looked", async () => {
    const { library, check } = setup({ missingCli: true });
    library.agents.save(agent());
    const report = await check("a1");
    expect(report.checks.find((one) => one.name === "命令行工具")).toMatchObject({
      outcome: "fail",
      detail: expect.stringMatching(/找不到 claude/),
    });
  });

  it("a probe that never answers fails naming the deadline, not as a cancellation", async () => {
    const { library, check } = setup({
      answer: (request) =>
        new Promise((resolve) =>
          request.signal?.addEventListener("abort", () => resolve({ failed: true, cancelled: true, text: "" })),
        ),
    });
    library.agents.save(agent());
    const report = await check("a1");
    expect(report.checks.find((one) => one.name === "真的问一句")?.detail).toMatch(/秒内没有答复/);
  });

  it("a real answer outweighs a HEAD that timed out", async () => {
    const { library, check } = setup({ headFails: true });
    library.connections.save({
      connectionId: "gw",
      displayName: "网关",
      authMode: "api-key",
      backend: "claude-code",
      endpoint: "https://gw.example.com",
    });
    library.connections.setCredential("gw", "sk-1");
    library.agents.save(agent({ connectionId: "gw" }));
    const report = await check("a1");
    expect(report.checks.find((one) => one.name === "地址可达")).toMatchObject({
      outcome: "ok",
      detail: expect.stringContaining("HEAD timeout"),
    });
    expect(overallOf(report)).toBe("ok");
  });
});
