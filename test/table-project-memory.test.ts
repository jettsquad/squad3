// 移植自 Squad 2.x packages/table/test/project-memory.test.ts @ 8e96d9c
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureProjectMemoryFile } from "../src/main/table/project-memory.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "squad-memory-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("project memory initialization", () => {
  it("does not import background from parent or sibling projects into an empty project", async () => {
    const folder = join(root, "new-project");
    await mkdir(folder);
    await writeFile(join(root, "AGENTS.md"), "PARENT_SECRET_PROJECT");
    await mkdir(join(root, "neighbor"));
    await writeFile(join(root, "neighbor", "README.md"), "NEIGHBOR_SECRET_PROJECT");
    const initialized = await ensureProjectMemoryFile(folder, "AGENTS.md");
    expect(initialized.created).toBe(true);
    expect(initialized.text).toContain(folder);
    expect(initialized.text).toContain("尚未由主持人确认");
    expect(initialized.text).not.toMatch(/PARENT_SECRET_PROJECT|NEIGHBOR_SECRET_PROJECT/);
    expect(initialized.text).toContain("不得读取父目录");
  });

  it("preserves existing notes", async () => {
    await writeFile(join(root, "CLAUDE.md"), "Confirmed project facts");
    expect(await ensureProjectMemoryFile(root, "CLAUDE.md")).toEqual({
      created: false,
      text: "Confirmed project facts",
    });
  });

  it("initializes safely when two seats start together", async () => {
    const results = await Promise.all([
      ensureProjectMemoryFile(root, "AGENTS.md"),
      ensureProjectMemoryFile(root, "AGENTS.md"),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0]?.text).toBe(results[1]?.text);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(results[0]?.text);
  });
});
