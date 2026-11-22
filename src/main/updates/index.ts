import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
export { checkMacRelease } from "./releases.ts";

async function digest(file: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

export interface LocalUpdateFeed {
  readonly url: string;
  readonly version: string;
  readonly installer: string;
  close(): Promise<void>;
}

/** Reuses electron-updater's verified pending cache. No installer is uploaded or served over HTTP. */
export async function prepareLocalUpdate(options: {
  readonly source: string;
  readonly cacheDir: string;
  readonly isNewer: (version: string) => boolean;
}): Promise<LocalUpdateFeed> {
  const manifestPath = join(dirname(options.source), "latest.yml");
  if ((await stat(manifestPath)).size > 65536) throw new Error("本地更新说明超过大小上限。");
  const manifest = await readFile(manifestPath, "utf8");
  // The publisher's generated root scalar fields; arbitrary YAML tags are never evaluated.
  const version = /^version:\s*([\w.+-]+)\s*$/m.exec(manifest)?.[1];
  const fileName = /^path:\s*([^\r\n]+?)\s*$/m.exec(manifest)?.[1];
  const sha512 = /^sha512:\s*([A-Za-z0-9+/]{86}==)\s*$/m.exec(manifest)?.[1];
  if (
    version === undefined ||
    fileName === undefined ||
    sha512 === undefined ||
    fileName !== basename(options.source) ||
    fileName !== `Squad-Setup-${version}.exe`
  ) {
    throw new Error("安装包与旁边的 latest.yml 不匹配，请选择同一版本的一整套本地发布文件。");
  }
  if (!options.isNewer(version)) throw new Error("本地安装包没有比当前版本更新，不进行降级或重复安装。");
  const info = await stat(options.source);
  if (!info.isFile() || info.size < 1 || info.size > 512 * 1024 * 1024)
    throw new Error("本地更新包无效或超过 512 MiB。");
  if ((await digest(options.source)) !== sha512) throw new Error("本地安装包 SHA-512 校验失败，没有安装。");
  const pending = join(options.cacheDir, "pending");
  await mkdir(pending, { recursive: true });
  const installer = join(pending, fileName);
  const temporary = join(pending, `local-${randomUUID()}.tmp`);
  try {
    await copyFile(options.source, temporary);
    if ((await digest(temporary)) !== sha512) throw new Error("本地更新包复制后校验失败。");
    await rename(temporary, installer);
    const updateInfo = join(pending, `info-${randomUUID()}.tmp`);
    await writeFile(updateInfo, JSON.stringify({ fileName, sha512, isAdminRightsRequired: false }));
    await rename(updateInfo, join(pending, "update-info.json"));
  } finally {
    await rm(temporary, { force: true });
  }

  // Public updater API still performs version/cache verification and its normal quit-and-install.
  // Only a tiny manifest is read over loopback; the .exe route intentionally does not exist.
  const localManifest = JSON.stringify({
    version,
    files: [{ url: fileName, sha512, size: info.size }],
    path: fileName,
    sha512,
  });
  const server = createServer((request, response) => {
    if (/^\/(?:latest|dev|beta|alpha)(?:-[\w-]+)?\.yml(?:\?.*)?$/.test(request.url ?? "")) {
      response.writeHead(200, { "Content-Type": "text/yaml", "Cache-Control": "no-store" });
      response.end(localManifest);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((ok, bad) => {
    server.once("error", bad);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", bad);
      ok();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("无法建立本地更新入口。");
  }
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(expiry);
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  };
  const expiry = setTimeout(
    () => {
      void close();
    },
    15 * 60 * 1000,
  );
  expiry.unref();
  return { url: `http://127.0.0.1:${address.port}`, version, installer, close };
}
