// 移植自 Squad 2.x packages/console/test/parse.test.ts @ 8dcb903
/**
 * This reads what a person typed. A grammar that silently mis-parses builds a
 * team with the wrong seats, or sends an instruction to nobody, and says
 * nothing either way.
 */
import { describe, expect, it } from "vitest";
import { checkTeamDraft, checkTeamFields, isAbsolutePath, parseNewTeam, parseSay } from "../src/shared/parse.ts";

describe("parseNewTeam", () => {
  it("reads a name, a folder and a roster", () => {
    const input = parseNewTeam("评审组 | /Users/me/proj | 甲=架构, 乙=测试");
    expect(input.displayName).toBe("评审组");
    expect(input.projectFolder).toBe("/Users/me/proj");
    expect(input.seats).toEqual([
      { seatId: "seat-1", displayName: "甲", role: "架构", isSecretary: false },
      { seatId: "seat-2", displayName: "乙", role: "测试", isSecretary: false },
    ]);
  });

  it("allows spaces in the folder and the role", () => {
    // Pipes rather than positional whitespace, because both of these
    // legitimately contain spaces.
    const input = parseNewTeam("组 | /Users/me/my proj | 甲=后端 与 数据");
    expect(input.projectFolder).toBe("/Users/me/my proj");
    expect(input.seats[0]?.role).toBe("后端 与 数据");
  });

  it("defaults a role rather than leaving it blank", () => {
    expect(parseNewTeam("组 | /p | 甲").seats[0]?.role).toBe("通用");
  });

  it("accepts full-width separators", () => {
    // The person typing this is writing Chinese; their comma is ，
    expect(parseNewTeam("组 | /p | 甲：架构，乙：测试").seats).toHaveLength(2);
  });

  it("refuses a relative folder", () => {
    // It would resolve against whatever the harness's cwd happens to be,
    // which is not where the person thinks they are.
    expect(() => parseNewTeam("组 | proj | 甲")).toThrow(/绝对路径/);
  });

  it("refuses duplicate seat names", () => {
    // Two seats called 甲 are indistinguishable in the record afterwards.
    expect(() => parseNewTeam("组 | /p | 甲, 甲")).toThrow(/重复/);
  });

  it("explains the usage when a section is missing", () => {
    expect(() => parseNewTeam("组 | /p")).toThrow(/用法/);
  });
});

describe("parseSay", () => {
  const roster = ["甲", "乙"];

  it("takes a plain instruction as addressed to everyone", () => {
    expect(parseSay("看一下这个设计", roster)).toEqual({ instruction: "看一下这个设计", named: [] });
  });

  it("reads a roll-call before the instruction", () => {
    expect(parseSay("甲,乙: 各自评审", roster)).toEqual({ instruction: "各自评审", named: ["甲", "乙"] });
  });

  it("does not mistake an ordinary colon for a roll-call", () => {
    // Decided against the roster, not by shape. Shape was tried: 「结论」 is
    // short and space-free and read exactly like a name, so the first clause
    // vanished and the instruction went to a seat that does not exist.
    expect(parseSay("结论：我们用 Postgres，请评估迁移成本", roster)).toEqual({
      instruction: "结论：我们用 Postgres，请评估迁移成本",
      named: [],
    });
  });

  it("treats a partly-unknown roll-call as prose rather than dropping the unknown name", () => {
    // Silently addressing only 甲 would look like 丙 had nothing to say.
    expect(parseSay("甲,丙: 评审", roster).named).toEqual([]);
  });

  it("addresses everyone when no team is selected", () => {
    expect(parseSay("甲: 评审").named).toEqual([]);
  });

  it("refuses an empty instruction", () => {
    expect(() => parseSay("   ", roster)).toThrow(/用法/);
  });
});

describe("秘书标记", () => {
  it("* 指派秘书", () => {
    const input = parseNewTeam("组 | /p | 甲*=架构, 乙=测试");
    expect(input.seats.map((seat) => seat.isSecretary)).toEqual([true, false]);
    // The marker must not survive into the name — a seat called 「甲*」 would
    // fail every roll-call the person then types.
    expect(input.seats[0]?.displayName).toBe("甲");
  });

  it("全角 ＊ 也算", () => {
    expect(parseNewTeam("组 | /p | 甲＊").seats[0]?.isSecretary).toBe(true);
  });

  it("没有 * 就没有秘书", () => {
    expect(parseNewTeam("组 | /p | 甲, 乙").seats.some((seat) => seat.isSecretary)).toBe(false);
  });

  it("两个 * 被拒", () => {
    expect(() => parseNewTeam("组 | /p | 甲*, 乙*")).toThrow(/只能有一位秘书/);
  });
});

describe("checkTeamFields", () => {
  it("每条抱怨都挂在出问题的那个字段上", () => {
    // 面板里三个输入框各一个。之前整条斜杠命令用法印在三个空框下面，红的。
    const problems = checkTeamFields({});
    expect(problems.map((problem) => problem.field).sort()).toEqual(["displayName", "projectFolder", "roster"]);
  });

  it("只缺文件夹就只说文件夹", () => {
    const problems = checkTeamFields({ displayName: "评审组", roster: "甲=架构" });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe("projectFolder");
  });

  it("相对路径被挡在字段上，不是挡在语法上", () => {
    const problems = checkTeamFields({ displayName: "组", projectFolder: "proj", roster: "甲" });
    expect(problems[0]?.field).toBe("projectFolder");
    expect(problems[0]?.detail).toMatch(/绝对路径/);
  });

  it("名册的问题落在名册上", () => {
    const problems = checkTeamFields({ displayName: "组", projectFolder: "/p", roster: "甲*, 乙*" });
    expect(problems[0]?.field).toBe("roster");
    expect(problems[0]?.detail).toMatch(/只能有一位秘书/);
  });

  it("名字里的竖线会变成字段分隔符，所以拒掉", () => {
    const problems = checkTeamFields({ displayName: "a|b", projectFolder: "/p", roster: "甲" });
    expect(problems[0]?.field).toBe("displayName");
  });

  it("填全了就没有抱怨", () => {
    expect(checkTeamFields({ displayName: "组", projectFolder: "/p", roster: "甲*=架构, 乙=测试" })).toEqual([]);
  });
});

describe("checkTeamDraft", () => {
  const member = (templateId: string, isSecretary?: boolean) => ({
    templateId,
    ...(isSecretary === undefined ? {} : { isSecretary }),
  });

  it("一个都不选就说选人，不说语法", () => {
    // 面板不再打名册文本，所以抱怨要落在选择上。
    const problems = checkTeamDraft({ displayName: "组", projectFolder: "/p" });
    expect(problems.map((problem) => problem.field)).toEqual(["members"]);
    expect(problems[0]?.detail).toMatch(/至少选一个 Agent/);
  });

  it("选了人但没指秘书也拦下来", () => {
    // 没有秘书 = 排不了议程 = 这支团队做不了它存在的那件事。
    const problems = checkTeamDraft({ displayName: "组", projectFolder: "/p", members: [member("a")] });
    expect(problems[0]?.field).toBe("members");
    expect(problems[0]?.detail).toMatch(/秘书/);
  });

  it("两个秘书被拒", () => {
    const problems = checkTeamDraft({
      displayName: "组",
      projectFolder: "/p",
      members: [member("a", true), member("b", true)],
    });
    expect(problems.some((problem) => /只能有一位秘书/.test(problem.detail))).toBe(true);
  });

  it("名字和文件夹各自抱怨各自的", () => {
    const problems = checkTeamDraft({ projectFolder: "proj", members: [member("a", true)] });
    expect(problems.map((problem) => problem.field).sort()).toEqual(["displayName", "projectFolder"]);
  });

  it("齐了就没有抱怨", () => {
    expect(
      checkTeamDraft({ displayName: "组", projectFolder: "/p", members: [member("a", true), member("b")] }),
    ).toEqual([]);
  });
});

describe("/squad-say 也认 @", () => {
  it("开头的 @ 点名，并且从正文里挖掉", () => {
    // 面板用 @，1.x 也用 @。命令行只认冒号语法的话，同一句话在输入框里问的是
    // 一个人，在命令行问的是全队——而且没有任何东西说你拿到的是哪一种。
    expect(parseSay("@甲 看看这个", ["甲", "乙"])).toEqual({ instruction: "看看这个", named: ["甲"] });
  });

  it("句中的 @ 也点名，但正文原样保留", () => {
    expect(parseSay("这段请 @甲 复核", ["甲"])).toEqual({ instruction: "这段请 @甲 复核", named: ["甲"] });
  });

  it("冒号语法优先，行为不变", () => {
    expect(parseSay("甲,乙: 一起看", ["甲", "乙"])).toEqual({ instruction: "一起看", named: ["甲", "乙"] });
  });

  it("认不出的 @ 不改变任何东西", () => {
    // 「联系我 @公司邮箱」是正常写作，不该被当成点名，也不该被拦下来。
    expect(parseSay("发到 @公司邮箱 那边", ["甲"])).toEqual({ instruction: "发到 @公司邮箱 那边", named: [] });
  });
});

describe("Windows 路径（Squad 3 新增）", () => {
  it("盘符路径和 UNC 路径都算绝对路径", () => {
    expect(isAbsolutePath("J:\\project\\Squad3")).toBe(true);
    expect(isAbsolutePath("J:/project/Squad3")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share\\x")).toBe(true);
    expect(isAbsolutePath("/Users/alex/x")).toBe(true);
  });

  it("相对路径照旧拒", () => {
    expect(isAbsolutePath("project\\x")).toBe(false);
    expect(isAbsolutePath("J:project")).toBe(false);
  });

  it("/squad-new 接受 Windows 的项目文件夹", () => {
    expect(parseNewTeam("组 | J:\\project\\Squad3 | 甲*=架构").projectFolder).toBe("J:\\project\\Squad3");
  });
});
