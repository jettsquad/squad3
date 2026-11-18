import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkConnection, envForConnection, type SeatConnection } from "../src/shared/connection.ts";
import { createSeats } from "../src/main/seats/index.ts";
import { createCloudAdapter, cloudResume, cloudScope, cloudSshArgs } from "../src/main/seats/cloud/adapter.ts";
import { createLibrary } from "../src/main/library/index.ts";
import { createVault } from "../src/main/vault/index.ts";
import { createAgentCheck } from "../src/main/agent-check/index.ts";
import type { SeatSpec } from "../src/shared/seat.ts";

const folders: string[] = [];
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(flavor = "chat", noLocal = false) {
  const dir = mkdtempSync(join(tmpdir(), "squad-cloud-"));
  folders.push(dir);
  const identityFile = join(dir, "identity");
  const knownHostsFile = join(dir, "known_hosts");
  writeFileSync(identityFile, "public diagnostic fixture, no real key");
  writeFileSync(knownHostsFile, "fixture");
  const connection: SeatConnection = {
    connectionId: "cloud",
    displayName: "云端 MiniMax",
    authMode: "api-key",
    backend: "codex",
    source: "octopus",
    cloud: {
      host: "example.test",
      port: 22,
      user: "root",
      identityFile,
      knownHostsFile,
      executable: "/opt/codex",
      runAs: "runner",
      revision: "1",
    },
  };
  let localStarts = 0;
  const resolver = (name: string) => {
    if (name === "ssh")
      return { file: process.execPath, prefixArgs: [resolve("test/fixtures/cloud-runtime.mjs"), "cloud", flavor] };
    if (name === "codex") {
      localStarts++;
      if (noLocal) throw new Error("local CLI not installed");
      return { file: process.execPath, prefixArgs: [resolve("test/fixtures/cloud-runtime.mjs"), "local"] };
    }
    return { file: "powershell.exe", prefixArgs: [] };
  };
  const seat: SeatSpec = {
    seatId: "seat",
    displayName: "甲",
    role: "分析",
    systemPrompt: "负责分析。",
    backend: "codex",
    permissionMode: "read-only",
  };
  const adapter = createCloudAdapter({ stateDir: join(dir, "state"), resolve: resolver });
  return { dir, connection, seat, adapter, resolver, localStarts: () => localStarts };
}

describe("cloud sources", () => {
  it("keeps legacy local validation and rejects cross-source credentials or shell injection", () => {
    const s = setup();
    expect(checkConnection(s.connection)).toEqual([]);
    expect(envForConnection(s.connection, "MUST_NOT_LEAVE_LOCAL")).toEqual({});
    expect(checkConnection({ ...s.connection, credentialRef: "LOCAL_KEY" }).length).toBeGreaterThan(0);
    expect(
      checkConnection({ ...s.connection, cloud: { ...s.connection.cloud!, user: "root;evil" } }).length,
    ).toBeGreaterThan(0);
    expect(
      checkConnection({
        connectionId: "old",
        displayName: "old",
        backend: "codex",
        authMode: "subscription",
        endpoint: "https://bad.test",
      }).length,
    ).toBeGreaterThan(0);
    expect(cloudSshArgs(s.connection)).toContain("StrictHostKeyChecking=yes");
  });
  it("stores remote profiles without deriving or resolving a local model key", () => {
    const s = setup();
    const vault = createVault({
      dataDir: s.dir,
      env: {},
      cipher: { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
    });
    const library = createLibrary({ dataDir: s.dir, vault });
    expect(library.connections.save(s.connection).credentialRef).toBeUndefined();
    expect(library.connections.envFor("cloud")).toEqual({});
    expect(() => library.connections.setCredential("cloud", "no")).toThrow(/服务器/);
  });
  it("routes chat through cloud with no local CLI or model login, and scopes continuation", async () => {
    const s = setup("chat", true);
    const seats = createSeats({ stateDir: join(s.dir, "state"), resolve: s.resolver });
    const adapter = seats.adapterFor("codex");
    if (typeof adapter === "string") throw new Error(adapter);
    const result = await adapter.start({
      seat: s.seat,
      connection: { connection: s.connection, env: {} },
      cwd: s.dir,
      sessionScope: "scene-1",
      prompt: "hello",
    }).result;
    expect(result.failed).toBe(false);
    expect(result.text).toBe("REMOTE_ONLY");
    expect(s.localStarts()).toBe(0);
    expect(cloudResume(result.sessionId, cloudScope(s.connection, s.dir, "seat", "scene-1"))).toBe("test-cloud-thread");
    expect(cloudResume(result.sessionId, cloudScope(s.connection, s.dir, "seat", "scene-2"))).toBeUndefined();
    const revised = { ...s.connection, cloud: { ...s.connection.cloud!, revision: "2" } };
    const reset = await adapter.start({
      seat: s.seat,
      connection: { connection: revised, env: {} },
      cwd: s.dir,
      sessionScope: "scene-1",
      resumeId: result.sessionId,
      prompt: "hello",
    }).result;
    expect(reset.resetSession).toBe(true);
  });
  it("executes on the workstation with the actual seat permissions, without exporting local secrets", async () => {
    const s = setup("tool");
    process.env["SQUAD_CLOUD_TEST_SECRET"] = "must-not-export";
    try {
      const result = await s.adapter.start({
        seat: s.seat,
        connection: { connection: s.connection, env: { SECRET: "must-not-export" } },
        cwd: s.dir,
        prompt: "tool",
      }).result;
      expect(result.failed).toBe(false);
      const output = JSON.parse(result.text) as { stdout: string; exitCode: number };
      expect(output.exitCode).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual({
        local: true,
        cwd: s.dir,
        policy: { type: "readOnly", networkAccess: false },
        secretLeaked: false,
      });
      expect(readdirSync(join(s.dir, "state/cloud-pending"))).toEqual([]);
    } finally {
      delete process.env["SQUAD_CLOUD_TEST_SECRET"];
    }
  });
  it("does not fall back to a local model when the cloud account fails", async () => {
    const s = setup("fail", true);
    const result = await s.adapter.start({
      seat: s.seat,
      connection: { connection: s.connection, env: {} },
      cwd: s.dir,
      prompt: "hello",
    }).result;
    expect(result.failed).toBe(true);
    expect(result.text).toContain("remote account unavailable");
    expect(s.localStarts()).toBe(0);
  });
  it("cancels a waiting remote turn without rejecting the SeatRun result", async () => {
    const s = setup("wait");
    const abort = new AbortController();
    const run = s.adapter.start({
      seat: s.seat,
      connection: { connection: s.connection, env: {} },
      cwd: s.dir,
      prompt: "wait",
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 150);
    const result = await run.result;
    expect(result.cancelled).toBe(true);
    expect(result.failed).toBe(true);
  });
  it("checks cloud chat without invoking local locate, HEAD or credential resolution", async () => {
    const s = setup("chat", true);
    const library = createLibrary({
      dataDir: s.dir,
      vault: createVault({
        dataDir: s.dir,
        env: {},
        cipher: { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
      }),
    });
    library.connections.save(s.connection);
    library.agents.save({
      ...s.seat,
      templateId: "a",
      connectionId: "cloud",
      secretaryCandidate: true,
      enabled: true,
      color: "red",
    });
    const seats = createSeats({ stateDir: join(s.dir, "state"), resolve: s.resolver });
    const report = await createAgentCheck({
      seats,
      library,
      fetch: (() => {
        throw new Error("HEAD not appropriate for SSH");
      }) as typeof fetch,
    })("a");
    expect(report.checks.at(-1)?.outcome).toBe("ok");
    expect(s.localStarts()).toBe(0);
    expect(existsSync(s.dir)).toBe(true);
  });
});
