import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_BYTES = 256 * 1024;
const TEXT = new Set([".md", ".markdown", ".txt"]);

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

export async function listArtifacts(project: string, planned: readonly string[]): Promise<string[]> {
  const root = await realpath(project);
  const reports = resolve(root, ".squad", "reports");
  const folder = await realpath(reports).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const files = folder === undefined || !inside(root, folder) ? [] : await readdir(folder, { withFileTypes: true });
  const candidates = new Set(
    [...files.filter((file) => file.isFile()).map((file) => ".squad/reports/" + file.name), ...planned].filter((path) =>
      TEXT.has(extname(path).toLowerCase()),
    ),
  );
  return [...candidates].sort((a, b) => a.localeCompare(b));
}

export async function readArtifact(project: string, path: string): Promise<{ text: string; version: string }> {
  if (isAbsolute(path) || !TEXT.has(extname(path).toLowerCase()))
    throw new Error("请选择项目内的 Markdown 或文本产物。");
  const root = await realpath(project);
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) throw new Error("产物路径超出项目目录。");
  const target = await realpath(candidate);
  if (!inside(root, target)) throw new Error("产物链接超出项目目录。");
  const file = await open(target, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("只支持 256 KiB 以内的文本文件。");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new Error("读取期间文件发生变化，请重试。");
    const bytes = buffer.subarray(0, bytesRead);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, version: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await file.close();
  }
}
