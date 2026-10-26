// 移植自 Squad 2.x packages/table/test/export.test.ts @ 8dcb903
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderDiscussion, writeDiscussion } from "../src/main/table/export.ts";

const at = new Date(2026, 9, 2, 14, 5).getTime();
const events = [
  { kind: "permission/preset", text: "", turnId: "seq-0", at },
  { kind: "user/message", text: "【主持人】查一下文档和程序", turnId: "t1", at },
  { kind: "user/message", text: "【郑三】先别急。\n\n## 证据\n在这里", turnId: "t2", at: at + 60_000 },
];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("renderDiscussion", () => {
  const markdown = renderDiscussion({ teamName: "HikingHub", teamId: "sit-1", events, exportedAt: at });

  it("只有说过的话，谁说的、什么时候说的", () => {
    expect(markdown).toContain("## 主持人 · 2026-10-02 14:05\n\n查一下文档和程序");
    expect(markdown).toContain("## 郑三 · 2026-10-02 14:06\n\n先别急。");
    expect(markdown).not.toContain("permission/preset");
  });

  it("开头说清这是副本，改它没用", () => {
    expect(markdown).toContain("# HikingHub · 讨论记录");
    expect(markdown).toContain("只读副本");
    expect(markdown).toContain("共 2 条");
  });
});

describe("writeDiscussion", () => {
  it("写进项目的 .squad/discussions，并让整个目录不进版本库", async () => {
    const project = mkdtempSync(join(tmpdir(), "squad-export-"));
    folders.push(project);
    await writeDiscussion(project, "sit-1", "# x\n");
    expect(readFileSync(join(project, ".squad/discussions/sit-1.md"), "utf8")).toBe("# x\n");
    expect(readFileSync(join(project, ".squad/.gitignore"), "utf8")).toContain("\n*\n");
  });

  it("项目文件夹不在（盘没挂）就什么都不建", async () => {
    const gone = join(tmpdir(), `squad-export-gone-${Date.now()}`);
    await writeDiscussion(gone, "sit-1", "# x\n");
    expect(existsSync(gone)).toBe(false);
  });

  it("副本被删了、被改了，下次导出原样写回来", async () => {
    const project = mkdtempSync(join(tmpdir(), "squad-export-"));
    folders.push(project);
    await writeDiscussion(project, "sit-1", "# 第一次\n");
    await writeDiscussion(project, "sit-1", "# 第二次\n");
    expect(readFileSync(join(project, ".squad/discussions/sit-1.md"), "utf8")).toBe("# 第二次\n");
  });
});
