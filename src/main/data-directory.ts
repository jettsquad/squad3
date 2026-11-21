import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

interface Location {
  current?: string;
  pending?: string;
}

const DATA_ENTRIES = ["teams", "library", "criteria", "seats", "vault.json", "browser-bridge"];

function verifyCopy(source: string, target: string): void {
  const original = lstatSync(source);
  if (original.isSymbolicLink()) throw new Error("数据目录中包含符号链接，不能自动迁移：" + source);
  if (original.isDirectory()) {
    for (const name of readdirSync(source)) verifyCopy(join(source, name), join(target, name));
  } else if (original.isFile()) {
    const hash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
    if (hash(source) !== hash(target)) throw new Error("数据校验失败：" + source);
  } else {
    throw new Error("数据目录中包含无法迁移的特殊文件：" + source);
  }
}

export function locationFile(defaultDir: string): string {
  return join(dirname(defaultDir), "Squad-data-location.json");
}

function readLocation(defaultDir: string): Location {
  const path = locationFile(defaultDir);
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("数据目录配置无效。");
  const value = parsed as Location;
  for (const dir of [value.current, value.pending]) {
    if (dir !== undefined && (typeof dir !== "string" || !isAbsolute(dir))) throw new Error("数据目录路径无效。");
  }
  return value;
}

function writeLocation(defaultDir: string, value: Location): void {
  const path = locationFile(defaultDir);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

export function scheduleDataMove(defaultDir: string, destination: string): void {
  const config = readLocation(defaultDir);
  const source = resolve(config.current ?? defaultDir);
  const target = resolve(destination);
  const forward = relative(source, target);
  const backward = relative(target, source);
  if (
    forward === "" ||
    (!forward.startsWith("..") && !isAbsolute(forward)) ||
    (!backward.startsWith("..") && !isAbsolute(backward))
  ) {
    throw new Error("新旧数据目录不能相同或互相包含。");
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error("请选择现有的文件夹。");
  if (readdirSync(target).length !== 0) throw new Error("请选择空文件夹，避免覆盖现有文件。");
  writeLocation(defaultDir, { current: source, pending: target });
}

export function activateDataDirectory(defaultDir: string): string {
  const config = readLocation(defaultDir);
  const source = config.current ?? defaultDir;
  if (config.pending === undefined) {
    if (!existsSync(source)) throw new Error("已配置的数据目录不存在：" + source);
    return source;
  }
  const target = config.pending;
  if (!existsSync(target) || readdirSync(target).some((name) => name !== ".squad-transfer")) {
    throw new Error("迁移目标不再是空文件夹：" + target);
  }
  const staging = join(target, ".squad-transfer");
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  for (const name of DATA_ENTRIES) {
    const from = join(source, name);
    if (existsSync(from)) {
      cpSync(from, join(staging, name), { recursive: true, errorOnExist: true, force: false, dereference: false });
      verifyCopy(from, join(staging, name));
    }
  }
  for (const name of readdirSync(staging)) renameSync(join(staging, name), join(target, name));
  rmdirSync(staging);
  writeLocation(defaultDir, { current: target });
  return target;
}
