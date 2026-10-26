/**
 * vault — where secrets live, by name (design doc §7).
 *
 * Replaces dsh's `ctx.credentials`, which 2.x borrowed. Its rules come along:
 *
 * - Configuration holds a REFERENCE (a name), never a value. Rotating a key
 *   touches no configuration and reaches the very next turn.
 * - `describe` answers "is it configured, from where, can it be written here"
 *   without returning the value — the reason a settings screen can show a
 *   badge without a secret ever reaching the renderer.
 * - A read-only source shadows a writable one, and a write under a shadowed
 *   name is REFUSED rather than accepted. "Saved, but reads back as something
 *   else" is exactly the failure this project keeps designing out.
 *
 * Two sources, in order: the process environment (read-only — it is the
 * person's own shell), then the encrypted store in the data directory. The
 * cipher is Electron's `safeStorage` in the app (DPAPI on Windows, Keychain on
 * macOS) and injected so this is testable without Electron.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../store/index.ts";

export interface Cipher {
  readonly available: () => boolean;
  readonly encrypt: (plain: string) => Buffer;
  readonly decrypt: (sealed: Buffer) => string;
}

export interface CredentialDescription {
  readonly configured: boolean;
  /** Where the value would be read from: the environment, the vault, or nowhere. */
  readonly source: "env" | "vault" | "none";
  /** Whether `set` under this name would take effect. False while the environment shadows it. */
  readonly writable: boolean;
}

export interface Vault {
  describe(ref: string): CredentialDescription;
  /** The value, for building a seat's environment. Never sent to the renderer. */
  resolve(ref: string): string | undefined;
  set(ref: string, value: string): void;
  remove(ref: string): void;
}

/** A reference is an environment-variable name: dsh branded it a POSIX identifier, and so do we. */
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkRef(ref: string): void {
  // The value is not repeated: a malformed "name" is most often a pasted key.
  if (!REF.test(ref)) throw new Error("凭据名不合法：只能用字母、数字和下划线，且不能以数字开头。");
}

export function createVault(options: {
  readonly dataDir: string;
  readonly cipher: Cipher;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Vault {
  const file = join(options.dataDir, "vault.json");
  const env = (): Readonly<Record<string, string | undefined>> => options.env ?? process.env;

  const load = (): Record<string, string> => {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  };
  const fromEnv = (ref: string): string | undefined => {
    const value = env()[ref];
    return value === undefined || value === "" ? undefined : value;
  };
  const fromVault = (ref: string): string | undefined => {
    const sealed = load()[ref];
    if (sealed === undefined) return undefined;
    return options.cipher.decrypt(Buffer.from(sealed, "base64"));
  };

  return {
    describe: (ref) => {
      checkRef(ref);
      if (fromEnv(ref) !== undefined) return { configured: true, source: "env", writable: false };
      if (load()[ref] !== undefined) return { configured: true, source: "vault", writable: true };
      return { configured: false, source: "none", writable: true };
    },
    resolve: (ref) => {
      checkRef(ref);
      return fromEnv(ref) ?? fromVault(ref);
    },
    set: (ref, value) => {
      checkRef(ref);
      if (fromEnv(ref) !== undefined) {
        throw new Error(
          `环境变量里已经有「${ref}」，它的值会盖过这里存的任何东西——所以这里不写。` +
            `要换 key，改那个环境变量；或者给这个连接换一个凭据名。`,
        );
      }
      if (value.trim() === "") throw new Error("密钥不能是空的。");
      if (!options.cipher.available()) {
        // Refused rather than stored in the clear: a key written to disk
        // unencrypted would outlive the reason it was saved.
        throw new Error("这台机器上的系统加密不可用，密钥没有保存。可以改用环境变量提供这把 key。");
      }
      const all = load();
      all[ref] = options.cipher.encrypt(value).toString("base64");
      writeJsonAtomic(file, all);
    },
    remove: (ref) => {
      checkRef(ref);
      const all = load();
      if (all[ref] === undefined) return;
      delete all[ref];
      writeJsonAtomic(file, all);
    },
  };
}
