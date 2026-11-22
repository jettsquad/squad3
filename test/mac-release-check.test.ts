import { expect, it } from "vitest";
import { selectMacRelease } from "../src/main/updates/releases.ts";

function released(version: string, arch?: "arm64" | "x64", overrides: { draft?: boolean; size?: number } = {}) {
  return {
    tag_name: `v${version}`,
    draft: overrides.draft ?? false,
    prerelease: version.includes("-"),
    assets:
      arch === undefined
        ? []
        : [{ name: `Squad-${version}-mac-${arch}.dmg`, state: "uploaded", size: overrides.size ?? 140_000_000 }],
  };
}

it("finds the newest matching Mac release and skips drafts, empty files and Windows-only releases", () => {
  const releases = [
    released("3.0.0-dev.11", "x64", { draft: true }),
    released("3.0.0-dev.9"),
    released("3.0.0-dev.13", "arm64", { size: 0 }),
    released("3.0.0-dev.12", "arm64"),
    released("3.0.0-dev.8", "x64"),
    released("3.0.0-dev.10", "x64"),
  ];
  expect(selectMacRelease("3.0.0-dev.8", "x64", releases)).toEqual({
    version: "3.0.0-dev.10",
    url: "https://github.com/jettsquad/squad3/releases/download/v3.0.0-dev.10/Squad-3.0.0-dev.10-mac-x64.dmg",
  });
  expect(selectMacRelease("3.0.0-dev.8", "arm64", releases)?.version).toBe("3.0.0-dev.12");
  expect(selectMacRelease("3.0.0-dev.10", "x64", releases)).toBeUndefined();
});

it("keeps stable installations on stable releases", () => {
  const releases = [released("3.2.0-dev.1", "x64"), released("3.1.0", "x64")];
  expect(selectMacRelease("3.0.0", "x64", releases)?.version).toBe("3.1.0");
  expect(selectMacRelease("3.1.0", "x64", releases)).toBeUndefined();
});
