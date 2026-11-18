import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { downloadFile, parseDownloadUrl } from "../seat-runtime/download.ts";

const active = new Map<string, Promise<string>>();
const extensions = ["png", "jpg", "gif", "webp", "bmp"] as const;

function imageExtension(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")
    return "webp";
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return "bmp";
  return undefined;
}

export function cacheRemoteImage(projectFolder: string, url: string): Promise<string> {
  parseDownloadUrl(url, true);
  const key = `${projectFolder}\0${url}`;
  const existing = active.get(key);
  if (existing !== undefined) return existing;
  const pending = cache(projectFolder, url).finally(() => active.delete(key));
  active.set(key, pending);
  return pending;
}

async function cache(projectFolder: string, url: string): Promise<string> {
  const root = await realpath(projectFolder);
  const dir = join(root, ".squad-image-cache");
  await mkdir(dir, { recursive: true });
  const realDir = await realpath(dir);
  if (relative(root, realDir) !== ".squad-image-cache") throw new Error("图片缓存文件夹不在项目文件夹内。");
  const hash = createHash("sha256").update(url).digest("hex");
  for (const ext of extensions) {
    const path = join(realDir, `${hash}.${ext}`);
    const actual = await realpath(path).catch(() => undefined);
    if (actual === path && (await stat(path)).isFile()) return path;
  }
  const file = await downloadFile(realDir, url, `${hash}.download`, { allowHttp: true, maxBytes: 12 * 1024 * 1024 });
  try {
    const ext = imageExtension(await readFile(file.path));
    if (ext === undefined) throw new Error("网址返回的内容不是支持的图片格式。");
    const path = join(realDir, `${hash}.${ext}`);
    await rename(file.path, path);
    return path;
  } finally {
    await rm(file.path, { force: true });
  }
}
