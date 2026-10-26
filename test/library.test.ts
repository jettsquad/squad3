import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLibrary } from "../src/main/library/index.ts";
import { createVault, type Cipher } from "../src/main/vault/index.ts";
import type { AgentTemplate, SeatConnection } from "../src/shared/index.ts";

const cipher: Cipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(plain, "utf8").reverse(),
  decrypt: (sealed) => Buffer.from(sealed).reverse().toString("utf8"),
};

function setup(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "squad-lib-"));
  const vault = createVault({ dataDir, cipher, env });
  return { dataDir, library: createLibrary({ dataDir, vault }) };
}

const gateway: SeatConnection = {
  connectionId: "conn-gw",
  displayName: "网关",
  authMode: "api-key",
  backend: "claude-code",
  endpoint: "https://gw.example.com",
  modelId: "MiniMax-H3",
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

describe("connections", () => {
  it("gives an api-key connection a credential name of its own, so nobody has to invent one", () => {
    const { library } = setup();
    const saved = library.connections.save(gateway);
    expect(saved.credentialRef).toBe("SQUAD_CONN_GW_KEY");
  });

  it("builds a seat's environment from the stored key, resolved at the moment of asking", () => {
    const { library } = setup();
    library.connections.save(gateway);
    library.connections.setCredential("conn-gw", "sk-1");
    expect(library.connections.envFor("conn-gw")).toEqual({
      ANTHROPIC_BASE_URL: "https://gw.example.com",
      ANTHROPIC_API_KEY: "sk-1",
      ANTHROPIC_MODEL: "MiniMax-H3",
    });
    // Rotated: the very next call sees it.
    library.connections.setCredential("conn-gw", "sk-2");
    expect(library.connections.envFor("conn-gw")["ANTHROPIC_API_KEY"]).toBe("sk-2");
  });

  it("shows whether a key is configured, never the key", () => {
    const { library } = setup();
    library.connections.save(gateway);
    expect(library.connections.views()[0]).toMatchObject({ credentialConfigured: false, credentialWritable: true });
    library.connections.setCredential("conn-gw", "sk-1");
    const view = library.connections.views()[0];
    expect(view).toMatchObject({ credentialConfigured: true });
    expect(JSON.stringify(view)).not.toContain("sk-1");
  });

  it("a key named after an exported variable is read from it, and cannot be overwritten here", () => {
    const { library } = setup({ MY_GATEWAY_KEY: "from-shell" });
    library.connections.save({ ...gateway, credentialRef: "MY_GATEWAY_KEY" });
    expect(library.connections.views()[0]).toMatchObject({ credentialConfigured: true, credentialWritable: false });
    expect(library.connections.envFor("conn-gw")["ANTHROPIC_API_KEY"]).toBe("from-shell");
    expect(() => library.connections.setCredential("conn-gw", "pasted")).toThrow(/环境变量/);
  });

  it("refuses a pasted key as a credential name, without repeating it", () => {
    const { library } = setup();
    const pasted = "sk-cp-thisIsAPastedKeyNotAName_0123456789";
    let message = "";
    try {
      library.connections.save({ ...gateway, credentialRef: pasted });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/填的像是 key 本身/);
    expect(message).not.toContain(pasted);
    expect(library.connections.list()).toEqual([]);
  });

  it("one connection with a malformed name is said on it; the rest still list", () => {
    const { library, dataDir } = setup();
    library.connections.save(gateway);
    library.connections.save({ ...gateway, connectionId: "conn-ok", displayName: "好的" });
    // As it was found on disk: saved by an older build that did not check names.
    const file = join(dataDir, "library", "connections.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as { items: Record<string, { credentialRef: string }> };
    const pasted = "sk-cp-thisIsAPastedKeyNotAName_0123456789";
    stored.items["conn-gw"] = { ...stored.items["conn-gw"]!, credentialRef: pasted };
    writeFileSync(file, JSON.stringify(stored));

    const views = library.connections.views();
    expect(views).toHaveLength(2);
    const bad = views.find((view) => view.connectionId === "conn-gw");
    expect(bad?.credentialProblem).toMatch(/填的像是 key 本身/);
    expect(JSON.stringify(views)).not.toContain(pasted);
    expect(views.find((view) => view.connectionId === "conn-ok")?.credentialProblem).toBeUndefined();
  });

  it("refuses what the shared rules refuse, with their sentence", () => {
    const { library } = setup();
    expect(() =>
      library.connections.save({
        connectionId: "c",
        displayName: "订阅",
        authMode: "subscription",
        backend: "claude-code",
        endpoint: "https://x",
      }),
    ).toThrow(/订阅模式不使用自定义端点/);
  });

  it("an edit keeps the id, so agents pointing at it stay attached", () => {
    const { library } = setup();
    library.connections.save(gateway);
    library.connections.save({ ...library.connections.get("conn-gw")!, displayName: "改名后的网关" });
    expect(library.connections.list().map((c) => [c.connectionId, c.displayName])).toEqual([
      ["conn-gw", "改名后的网关"],
    ]);
  });
});

describe("agents", () => {
  it("removal is soft: gone from the list, still found by id", () => {
    const { library } = setup();
    library.agents.save(agent());
    library.agents.remove("a1");
    expect(library.agents.list()).toEqual([]);
    expect(library.agents.get("a1")?.displayName).toBe("架构");
  });

  it("moving writes a position onto every entry, and a later save keeps it", () => {
    const { library } = setup();
    library.agents.save(agent({ templateId: "a1", displayName: "一" }));
    library.agents.save(agent({ templateId: "a2", displayName: "二" }));
    library.agents.save(agent({ templateId: "a3", displayName: "三" }));
    library.agents.move("a3", -2);
    expect(library.agents.list().map((a) => a.displayName)).toEqual(["三", "一", "二"]);
    library.agents.save({ ...library.agents.get("a3")!, role: "改了角色", order: undefined });
    expect(library.agents.list().map((a) => a.displayName)).toEqual(["三", "一", "二"]);
  });

  it("refuses a permission mode the backend has never heard of", () => {
    const { library } = setup();
    expect(() => library.agents.save(agent({ backend: "codex", permissionMode: "plan" }))).toThrow(/plan/);
  });

  it("survives a reload", () => {
    const { dataDir, library } = setup();
    library.agents.save(agent());
    const again = createLibrary({ dataDir, vault: createVault({ dataDir, cipher, env: {} }) });
    expect(again.agents.list().map((a) => a.templateId)).toEqual(["a1"]);
  });
});

describe("prompt blocks", () => {
  it("refuses a nameless or empty block, keeps order across an edit, and deletes softly", () => {
    const { library } = setup();
    expect(() => library.blocks.save({ blockId: "b0", name: " ", text: "x" })).toThrow(/小标题/);
    expect(() => library.blocks.save({ blockId: "b0", name: "n", text: " " })).toThrow(/空的/);
    library.blocks.save({ blockId: "b1", name: "一", text: "甲" });
    library.blocks.save({ blockId: "b2", name: "二", text: "乙" });
    library.blocks.reorder(["b2", "b1"]);
    library.blocks.save({ blockId: "b2", name: "二", text: "乙改" });
    expect(library.blocks.list().map((block) => block.blockId)).toEqual(["b2", "b1"]);
    library.blocks.remove("b2");
    expect(library.blocks.list().map((block) => block.blockId)).toEqual(["b1"]);
    expect(library.blocks.get("b2")?.text).toBe("乙改");
  });
});

describe("settings", () => {
  it("stores what seats call you, and refuses a blank name", () => {
    const { library } = setup();
    expect(library.settings.save({ hostDisplayName: "阿明" }).hostDisplayName).toBe("阿明");
    expect(() => library.settings.save({ hostDisplayName: "  " })).toThrow(/不能是空的/);
    expect(library.settings.get().hostDisplayName).toBe("阿明");
  });
});
