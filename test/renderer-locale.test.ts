/**
 * Every Chinese template the window translates has an English entry.
 *
 * A missing entry does not break anything — the Chinese shows instead — which
 * is exactly why it needs a test: nothing else would notice.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EN } from "../src/renderer/src/locales.ts";

const dir = join(import.meta.dirname, "../src/renderer/src");
const sources = readdirSync(dir)
  .filter((name) => /\.tsx?$/.test(name) && name !== "locales.ts")
  .map((name) => readFileSync(join(dir, name), "utf8"));

/** The string a JS literal spells, so `\n` and `\\` compare as the dictionary's keys do. */
const unescape = (literal: string): string => JSON.parse(`"${literal}"`) as string;

/** `t("…")` keys, plus the values of the label maps that are passed through `t()` at use. */
function templates(): readonly string[] {
  const found = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) found.add(unescape(match[1] ?? ""));
    for (const map of source.matchAll(
      /const (?:AUDIT_LABELS|HOLD|STATE|WEB_NOTE|EXIT_LABEL)[^=]*=\s*\{([\s\S]*?)\n\};/g,
    )) {
      for (const value of (map[1] ?? "").matchAll(/:\s*"((?:[^"\\]|\\.)*)"/g)) found.add(unescape(value[1] ?? ""));
    }
  }
  return [...found].filter((text) => /[一-鿿]/.test(text));
}

describe("window translations", () => {
  it("every translated Chinese template has English", () => {
    // A scan that found nothing would pass for the wrong reason.
    expect(templates().length).toBeGreaterThan(250);
    expect(templates()).toContain("看更早的（前面还有 {n} 条）");
    expect(templates()).toContain("建队");
    expect(templates().filter((text) => EN[text] === undefined)).toEqual([]);
  });

  it("an English template keeps every placeholder its Chinese one has", () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
    const broken = Object.entries(EN).filter(([zh, en]) => placeholders(zh).join() !== placeholders(en).join());
    expect(broken).toEqual([]);
  });
});
