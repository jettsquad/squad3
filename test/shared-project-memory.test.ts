// 移植自 Squad 2.x packages/shared/test/project-memory.test.ts @ 8dcb903
/**
 * 每个后端读自己的项目文件，互不相干——claude 不会去读 codex 的 AGENTS.md。
 * 这几条锁的是那个映射，以及缺失时给席位的那段话里两个不能丢的意思。
 */
import { describe, expect, it } from "vitest";
import {
  PROJECT_MEMORY_MAX_CHARS,
  PROJECT_MEMORY_RULES_BEGIN,
  PROJECT_MEMORY_RULES_END,
  projectMemoryFile,
  projectMemoryNote,
  projectMemoryRulesBlock,
  stripProjectMemoryRules,
  withProjectMemoryRules,
} from "../src/shared/project-memory.ts";

describe("projectMemoryFile", () => {
  it("各读各的", () => {
    expect(projectMemoryFile("claude-code")).toBe("CLAUDE.md");
    expect(projectMemoryFile("codex")).toBe("AGENTS.md");
  });

  it("没有这个约定的后端不硬造一个", () => {
    // 造一个只有 Squad 自己知道的文件名，等于建了一个没人读的文件。
    expect(projectMemoryFile("dsh")).toBeUndefined();
  });
});

describe("projectMemoryNote", () => {
  it("说清写什么，也说清不写什么", () => {
    const note = projectMemoryNote("CLAUDE.md").join("\n");
    expect(note).toContain("CLAUDE.md");
    expect(note).toContain("目录");
    // 角色和工作方式由团队给，写进项目文件就会漂成 Squad 里看不见的东西。
    expect(note).toContain("不要写你自己的角色");
  });

  it("要求顺手做完，不要占满这一轮", () => {
    // 一个整轮都在做杂务的席位等于没发言，那一轮会留一个看起来像「它没话说」的洞。
    expect(projectMemoryNote("AGENTS.md").join("\n")).toContain("不要把这一轮全用在这件事上");
  });
});

describe("写作规则", () => {
  it("规则块放在最上面，正文跟在后面", () => {
    const file = withProjectMemoryRules("# 项目\n\n正文");
    expect(file.startsWith(PROJECT_MEMORY_RULES_BEGIN)).toBe(true);
    expect(file).toContain(PROJECT_MEMORY_RULES_END);
    expect(file.trimEnd().endsWith("正文")).toBe(true);
  });

  it("反复套用不会叠出第二份规则", () => {
    // 程序每次写回都会重新放规则；已经带着规则的正文不能再多一份。
    const once = withProjectMemoryRules("# 项目");
    const twice = withProjectMemoryRules(once);
    expect(twice).toBe(once);
    expect(twice.split(PROJECT_MEMORY_RULES_BEGIN)).toHaveLength(2);
  });

  it("规则里写明上限、不许 @ 导入、作废内容直接删", () => {
    const rules = projectMemoryRulesBlock();
    expect(rules).toContain(PROJECT_MEMORY_MAX_CHARS.toLocaleString("en-US"));
    expect(rules).toContain("@路径");
    expect(rules).toContain("直接删掉");
  });

  it("新建文件的指令里带着规则，并要求原样放在开头", () => {
    const note = projectMemoryNote("CLAUDE.md").join("\n");
    expect(note).toContain(PROJECT_MEMORY_RULES_BEGIN);
    expect(note).toContain("原样放在文件最开头");
  });

  it("去掉规则块只留正文", () => {
    expect(stripProjectMemoryRules(withProjectMemoryRules("# 项目\n正文")).trim()).toBe("# 项目\n正文");
    expect(stripProjectMemoryRules("没有规则块的文件")).toBe("没有规则块的文件");
  });
});
