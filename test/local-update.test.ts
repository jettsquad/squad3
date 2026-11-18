import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { prepareLocalUpdate, type LocalUpdateFeed } from "../src/main/updates/index.ts";

const roots: string[] = [];
const feeds: LocalUpdateFeed[] = [];
afterEach(async () => {
  for (const feed of feeds.splice(0)) await feed.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "squad-local-update-"));
  roots.push(root);
  const name = "Squad-Setup-3.0.0-dev.3.exe";
  const source = join(root, name);
  const contents = Buffer.from("A test fixture, never executed");
  writeFileSync(source, contents);
  const sha512 = createHash("sha512").update(contents).digest("base64");
  const manifest = `version: 3.0.0-dev.3\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\npath: ${name}\nsha512: ${sha512}\n`;
  writeFileSync(join(root, "latest.yml"), manifest);
  return { root, source, contents, sha512, manifest, cacheDir: join(root, "cache"), isNewer: () => true };
}

describe("local updater", () => {
  it("stages a verified local package in the vendor's recognized cache, without serving its executable", async () => {
    const f = fixture();
    const feed = await prepareLocalUpdate(f);
    feeds.push(feed);
    expect(readFileSync(feed.installer)).toEqual(f.contents);
    const metadata = (await (await fetch(feed.url + "/latest.yml")).json()) as {
      version: string;
      files: { url: string }[];
    };
    expect(metadata.version).toBe("3.0.0-dev.3");
    expect(metadata.files[0]?.url).toBe("Squad-Setup-3.0.0-dev.3.exe");
    expect((await fetch(feed.url + "/Squad-Setup-3.0.0-dev.3.exe")).status).toBe(404);
    // Verify against electron-updater's real cache validator, not a second copy of our schema.
    const { DownloadedUpdateHelper } = createRequire(import.meta.url)(
      "electron-updater/out/DownloadedUpdateHelper.js",
    ) as {
      DownloadedUpdateHelper: new (cache: string) => {
        getValidCachedUpdateFile: (info: unknown, logger: unknown) => Promise<string | null>;
      };
    };
    const helper = new DownloadedUpdateHelper(f.cacheDir);
    expect(
      await helper.getValidCachedUpdateFile(
        { info: { sha512: f.sha512 } },
        { info: () => undefined, warn: () => undefined },
      ),
    ).toBe(feed.installer);
  });
  it("refuses a changed executable before writing updater state", async () => {
    const f = fixture();
    writeFileSync(f.source, "changed");
    await expect(prepareLocalUpdate(f)).rejects.toThrow(/校验失败/);
    expect(existsSync(f.cacheDir)).toBe(false);
  });
  it("refuses a downgrade or same-version installation", async () => {
    const f = fixture();
    await expect(prepareLocalUpdate({ ...f, isNewer: () => false })).rejects.toThrow(/没有比当前版本更新/);
  });
  it("refuses a manifest pointing at a different installer or an oversized manifest", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "latest.yml"), f.manifest.replace(/^path:.+$/m, "path: ../another.exe"));
    await expect(prepareLocalUpdate(f)).rejects.toThrow(/不匹配/);
    writeFileSync(join(f.root, "latest.yml"), "x".repeat(65537));
    await expect(prepareLocalUpdate(f)).rejects.toThrow(/大小上限/);
  });
});
