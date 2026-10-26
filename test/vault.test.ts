import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVault, type Cipher } from "../src/main/vault/index.ts";

/** Reversible and obviously not plaintext, so a test can see nothing is stored in the clear. */
const fakeCipher: Cipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from([...Buffer.from(plain, "utf8")].map((byte) => byte ^ 0x5a)),
  decrypt: (sealed) => Buffer.from([...sealed].map((byte) => byte ^ 0x5a)).toString("utf8"),
};

const dir = (): string => mkdtempSync(join(tmpdir(), "squad-vault-"));

describe("vault", () => {
  it("stores a value under its name, encrypted, and reads it back", () => {
    const dataDir = dir();
    const vault = createVault({ dataDir, cipher: fakeCipher, env: {} });
    vault.set("SQUAD_C1_KEY", "sk-secret-123");
    expect(vault.resolve("SQUAD_C1_KEY")).toBe("sk-secret-123");
    expect(readFileSync(join(dataDir, "vault.json"), "utf8")).not.toContain("sk-secret-123");
  });

  it("describes without revealing", () => {
    const vault = createVault({ dataDir: dir(), cipher: fakeCipher, env: {} });
    expect(vault.describe("SQUAD_C1_KEY")).toEqual({ configured: false, source: "none", writable: true });
    vault.set("SQUAD_C1_KEY", "sk-1");
    const described = vault.describe("SQUAD_C1_KEY");
    expect(described).toEqual({ configured: true, source: "vault", writable: true });
    expect(JSON.stringify(described)).not.toContain("sk-1");
  });

  it("the environment wins, and a write under a name it shadows is refused rather than silently ignored", () => {
    const vault = createVault({ dataDir: dir(), cipher: fakeCipher, env: { MY_KEY: "from-shell" } });
    expect(vault.describe("MY_KEY")).toEqual({ configured: true, source: "env", writable: false });
    expect(vault.resolve("MY_KEY")).toBe("from-shell");
    expect(() => vault.set("MY_KEY", "pasted")).toThrow(/环境变量/);
  });

  it("refuses to store a key when system encryption is unavailable", () => {
    const vault = createVault({ dataDir: dir(), cipher: { ...fakeCipher, available: () => false }, env: {} });
    expect(() => vault.set("SQUAD_C1_KEY", "sk-1")).toThrow(/系统加密不可用/);
  });

  it("refuses names that are not variable names", () => {
    const vault = createVault({ dataDir: dir(), cipher: fakeCipher, env: {} });
    expect(() => vault.describe("my key")).toThrow(/不合法/);
    expect(() => vault.set("1KEY", "x")).toThrow(/不合法/);
  });

  it("removes a value", () => {
    const vault = createVault({ dataDir: dir(), cipher: fakeCipher, env: {} });
    vault.set("SQUAD_C1_KEY", "sk-1");
    vault.remove("SQUAD_C1_KEY");
    expect(vault.resolve("SQUAD_C1_KEY")).toBeUndefined();
  });
});
