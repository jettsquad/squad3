import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compose } from "../src/main/compose.ts";
import { createDispatcher } from "../src/main/ipc/index.ts";

it("reuses a managed connection at startup and creates only one built-in agent", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "squad-cloud-trial-"));
  try {
    const app = compose({
      name: "Squad",
      version: "test",
      dataDir,
      cipher: { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() },
      pickFolder: async () => null,
      pickFiles: async () => [],
      push: () => undefined,
    });
    const dispatch = createDispatcher(app.handlers);
    const connection = {
      connectionId: "existing-cloud",
      displayName: "Existing",
      authMode: "api-key",
      backend: "codex",
      source: "octopus",
      cloud: {
        host: "example.com",
        port: 18443,
        user: "squad-gateway",
        runAs: "octopus-g0",
        executable: "/opt/octopus-g0/bin/codex-minimax",
        revision: "1",
        identityFile: join(dataDir, "key"),
        knownHostsFile: join(dataDir, "known_hosts"),
        managedDeviceId: "a".repeat(32),
      },
    };
    expect(await dispatch("connections.save", { connection })).toMatchObject({ ok: true });
    expect(await dispatch("connections.activateCloud", {})).toEqual({ ok: true, value: { connection } });
    expect(await dispatch("connections.activateCloud", {})).toEqual({ ok: true, value: { connection } });
    expect((await app.handlers["agents.list"]({})).agents).toMatchObject([
      { templateId: "squad-cloud-minimax-default", connectionId: connection.connectionId },
    ]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
