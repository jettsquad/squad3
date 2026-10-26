/**
 * A sandboxed preload may require `electron` and nothing else. Anything more
 * fails at load time, and the only symptom is a blank window with no
 * `window.squad` — every other check stays green. So the preload's value
 * imports are pinned here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function valueImports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1] ?? "");
}

describe("preload imports", () => {
  it("imports values only from electron and the dependency-free channels file", () => {
    expect(valueImports("src/preload/index.ts").sort()).toEqual(["../shared/channels.ts", "electron"]);
  });

  it("channels.ts imports nothing", () => {
    expect(valueImports("src/shared/channels.ts")).toEqual([]);
    expect(readFileSync("src/shared/channels.ts", "utf8")).not.toMatch(/^import /m);
  });
});
