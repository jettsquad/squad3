// 移植自 Squad 2.x packages/seat-claude-code/test/skills-plugin.test.ts @ 8dcb903
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SKILLS_PLUGIN_NAME,
  ensureSkillsPlugin,
  sharedSkillsDir,
} from "../src/main/seats/claude-code/skills-plugin.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "squad-skills-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sharedSkillsDir", () => {
  it("和 dsh 读同一个地方：DSH_AGENTS_HOME 优先，否则 ~/.agents", () => {
    // 两边不一致的话，同一张桌子上 dsh 席位和 Claude 席位看到的 skill 不一样。
    expect(sharedSkillsDir({ DSH_AGENTS_HOME: "/custom/agents" })).toBe(resolve("/custom/agents/skills"));
    expect(sharedSkillsDir({ DSH_AGENTS_HOME: "  " })).toBe(join(homedir(), ".agents", "skills"));
    expect(sharedSkillsDir({})).toBe(join(homedir(), ".agents", "skills"));
  });
});

describe("ensureSkillsPlugin", () => {
  it("没有共享 skill 目录时什么都不建，席位照常启动", async () => {
    expect(await ensureSkillsPlugin(join(root, "plugin"), join(root, "nope"))).toBeUndefined();
  });

  it("建出一个插件：清单加一个指向共享目录的链接", async () => {
    const skills = join(root, "agents", "skills");
    await mkdir(join(skills, "spec-trace"), { recursive: true });
    await writeFile(join(skills, "spec-trace", "SKILL.md"), "---\nname: spec-trace\n---\n", "utf8");

    const plugin = await ensureSkillsPlugin(join(root, "plugin"), skills);

    expect(plugin).toBe(join(root, "plugin"));
    const manifest = JSON.parse(await readFile(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.name).toBe(SKILLS_PLUGIN_NAME);
    expect(await readlink(join(root, "plugin", "skills"))).toBe(skills);
    // 是链接不是拷贝：共享目录里改了什么，下一个席位就看到什么。
    expect(await readFile(join(root, "plugin", "skills", "spec-trace", "SKILL.md"), "utf8")).toContain("spec-trace");
  });

  it("再跑一遍不出错，链接原样留着", async () => {
    const skills = join(root, "skills");
    await mkdir(skills, { recursive: true });
    await ensureSkillsPlugin(join(root, "plugin"), skills);
    expect(await ensureSkillsPlugin(join(root, "plugin"), skills)).toBe(join(root, "plugin"));
    expect(await readlink(join(root, "plugin", "skills"))).toBe(skills);
  });

  it("共享目录换了地方，链接跟着改", async () => {
    const before = join(root, "old");
    const after = join(root, "new");
    await mkdir(before, { recursive: true });
    await mkdir(after, { recursive: true });
    await mkdir(join(root, "plugin"), { recursive: true });
    await symlink(before, join(root, "plugin", "skills"), process.platform === "win32" ? "junction" : "dir");
    await ensureSkillsPlugin(join(root, "plugin"), after);
    expect(await readlink(join(root, "plugin", "skills"))).toBe(after);
  });
});
