/**
 * atomic.ts — replace a file so that a reader sees the old one or the new one, never half.
 *
 * Write a uniquely named temp file beside the target, then rename over it.
 * A crash between the two leaves a stray temp file, not a truncated config.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
