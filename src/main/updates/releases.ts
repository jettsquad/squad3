import semver from "semver";
import { z } from "zod";

const REPOSITORY = "jettsquad/squad3";
const feed = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(z.object({ name: z.string(), state: z.string(), size: z.number().nonnegative() })),
  }),
);

export interface MacRelease {
  readonly version: string;
  readonly url: string;
}

export function selectMacRelease(current: string, arch: "arm64" | "x64", data: unknown): MacRelease | undefined {
  const installed = semver.parse(current);
  if (installed === null) throw new Error("无法识别当前版本。");
  let selected: MacRelease | undefined;
  for (const release of feed.parse(data)) {
    const next = semver.parse(release.tag_name);
    if (release.draft || next === null || release.tag_name !== `v${next.version}`) continue;
    if (installed.prerelease.length === 0 && (release.prerelease || next.prerelease.length > 0)) continue;
    if (next.compare(selected?.version ?? installed.version) <= 0) continue;
    const name = `Squad-${next.version}-mac-${arch}.dmg`;
    if (release.assets.some((asset) => asset.name === name && asset.state === "uploaded" && asset.size > 0)) {
      selected = {
        version: next.version,
        url: `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`,
      };
    }
  }
  return selected;
}

export async function checkMacRelease(current: string, arch: "arm64" | "x64"): Promise<MacRelease | undefined> {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=50`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Squad Update Check" },
    signal: AbortSignal.timeout(12000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub 发布列表读取失败（HTTP ${response.status}）。`);
  return selectMacRelease(current, arch, await response.json());
}
