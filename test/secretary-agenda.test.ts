// 移植自 Squad 2.x packages/secretary/test/agenda.test.ts @ 8dcb903
/**
 * Drafting an agenda from a sentence. The model's reply is treated as hostile
 * input the whole way: tolerated around the edges, strict inside, and vetted
 * against the roster afterwards because a legal shape says nothing about the
 * seats being real.
 */
import { describe, expect, it } from "vitest";
import {
  assertPublicHostCommand,
  buildAgendaPrompt,
  extractJson,
  parseAgendaReply,
  type RosterSeat,
} from "../src/main/secretary/agenda.ts";
import { draftAgendaWith, type TextTaskRunner } from "../src/main/secretary/tasks.ts";

const seats: readonly RosterSeat[] = [
  { seatId: "seat-a", displayName: "甲" },
  { seatId: "seat-b", displayName: "乙" },
];

const wellFormed = JSON.stringify({
  phases: [{ title: "评审", contextMode: "independent", tasks: [{ seatId: "seat-a", instruction: "看设计" }] }],
});

const answering =
  (text: string, stopReason = "completed"): TextTaskRunner =>
  async () => ({ text, stopReason });

describe("assertPublicHostCommand", () => {
  it("refuses a command that points at private material", () => {
    // The secretary is private-blind. Passed through, an @ reference either
    // leaks or — worse, because it is silent — produces an agenda built
    // around something the secretary could not read and guessed at.
    expect(() => assertPublicHostCommand("请让 @密件 里的人先说")).toThrow(/@ 引用/);
  });

  it("accepts an ordinary instruction", () => {
    expect(() => assertPublicHostCommand("让两位各自独立评审这份设计")).not.toThrow();
  });

  it("accepts an email-looking token that is not a reference", () => {
    expect(() => assertPublicHostCommand("参考 a@b.com 的意见")).not.toThrow();
  });
});

describe("extractJson", () => {
  it("reads a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("reads an object the model wrapped in prose", () => {
    // The failure being avoided: a perfectly good agenda rejected because the
    // model said "Here you go:" first.
    expect(extractJson('好的，这是议程：\n{"a":1}\n希望有用')).toEqual({ a: 1 });
  });

  it("refuses a reply with no object at all", () => {
    expect(() => extractJson("我没法拟这个议程")).toThrow(/没有返回 JSON/);
  });
});

describe("parseAgendaReply", () => {
  it("accepts a well-formed agenda naming real seats", () => {
    expect(parseAgendaReply(wellFormed, seats).phases[0]?.title).toBe("评审");
  });

  it("reads a member's name written where the seat id belongs as that seat (3 新增)", () => {
    const byName = JSON.stringify({
      phases: [
        {
          title: "评审",
          contextMode: "independent",
          tasks: [
            { seatId: "甲", instruction: "看设计" },
            { seatId: "@乙", instruction: "看测试" },
            { seatId: "seat-a", instruction: "收尾" },
          ],
        },
      ],
    });
    expect(parseAgendaReply(byName, seats).phases[0]?.tasks.map((task) => task.seatId)).toEqual([
      "seat-a",
      "seat-b",
      "seat-a",
    ]);
  });

  it("still refuses a name two seats share, or nobody has", () => {
    const twins = [
      { seatId: "s1", displayName: "甲" },
      { seatId: "s2", displayName: "甲" },
    ];
    const reply = (seatId: string) =>
      JSON.stringify({
        phases: [{ title: "评审", contextMode: "independent", tasks: [{ seatId, instruction: "x" }] }],
      });
    expect(() => parseAgendaReply(reply("甲"), twins)).toThrow(/不存在的席位「甲」/);
    expect(() => parseAgendaReply(reply("丙"), seats)).toThrow(/不存在的席位「丙」/);
  });

  it("refuses an agenda naming a seat that does not exist", () => {
    // Refused, not returned with a warning: a draft the host can confirm is a
    // draft the table will run.
    const invented = wellFormed.replace("seat-a", "seat-z");
    expect(() => parseAgendaReply(invented, seats)).toThrow(/seat-z/);
  });
});

describe("draftAgendaWith", () => {
  it("checks for private material before contacting the secretary", async () => {
    // Order matters: a check on the way back would already have sent it.
    let called = false;
    const runner: TextTaskRunner = async () => {
      called = true;
      return { text: wellFormed, stopReason: "completed" };
    };
    await expect(draftAgendaWith(runner, { command: "问问 @密件", topic: "T", seats })).rejects.toThrow(/@ 引用/);
    expect(called).toBe(false);
  });

  it("returns the parsed agenda for an ordinary command", async () => {
    const agenda = await draftAgendaWith(answering(wellFormed), {
      command: "让甲评审设计",
      topic: "设计评审",
      seats,
    });
    expect(agenda.phases).toHaveLength(1);
  });

  it("refuses a draft that did not run to completion", async () => {
    await expect(
      draftAgendaWith(answering(wellFormed, "max-tokens"), { command: "让甲评审", topic: "T", seats }),
    ).rejects.toThrow(/max-tokens/);
  });
});

describe("buildAgendaPrompt", () => {
  it("lists the exact seat ids the model may use", () => {
    const prompt = buildAgendaPrompt({ command: "评审", topic: "设计", seats });
    expect(prompt).toContain("seat-a (甲), seat-b (乙)");
  });
});

describe("字段写错了一层", () => {
  const seats = [
    { seatId: "s1", displayName: "甲" },
    { seatId: "s2", displayName: "乙" },
  ];
  const reply = (phase: Record<string, unknown>) => JSON.stringify({ phases: [phase] });

  it("任务的字段写在了阶段上：挪到每条任务，而不是整份草案作废", () => {
    // 真实发生的：秘书把 publicContextCutoff 写在了阶段上，主持人看到的是一段校验器的 JSON。
    const agenda = parseAgendaReply(
      reply({
        title: "各自评审",
        contextMode: "independent",
        publicContextCutoff: "phase-start",
        tasks: [
          { seatId: "s1", instruction: "评审" },
          { seatId: "s2", instruction: "评审", publicContextCutoff: "immediately-before-turn" },
        ],
      }),
      seats,
    );
    expect(agenda.phases[0]?.tasks.map((task) => task.publicContextCutoff)).toEqual([
      "phase-start",
      "immediately-before-turn",
    ]);
  });

  it("阶段的字段写在了任务上：提到阶段，阶段自己写了的不覆盖", () => {
    const agenda = parseAgendaReply(
      reply({
        title: "入库",
        contextMode: "cumulative",
        maxAttempts: 2,
        tasks: [{ seatId: "s1", instruction: "提交", check: { command: "test -f a" }, maxAttempts: 5 }],
      }),
      seats,
    );
    expect(agenda.phases[0]?.check).toEqual({ command: "test -f a" });
    expect(agenda.phases[0]?.maxAttempts).toBe(2);
  });

  it("写在阶段上的文件路径只在该阶段只有一条任务时才挪：摊到几条任务上会互相覆盖", () => {
    const one = parseAgendaReply(
      reply({
        title: "写",
        contextMode: "cumulative",
        artifactPath: "docs/a.md",
        tasks: [{ seatId: "s1", instruction: "写" }],
      }),
      seats,
    );
    expect(one.phases[0]?.tasks[0]?.artifactPath).toBe("docs/a.md");
    const two = parseAgendaReply(
      reply({
        title: "写",
        contextMode: "cumulative",
        artifactPath: "docs/a.md",
        tasks: [
          { seatId: "s1", instruction: "写" },
          { seatId: "s2", instruction: "写" },
        ],
      }),
      seats,
    );
    expect(two.phases[0]?.tasks.every((task) => task.artifactPath === undefined)).toBe(true);
  });

  it("真不认识的字段仍然拒绝，但说的是人话：哪个阶段、多了什么", () => {
    expect(() =>
      parseAgendaReply(
        reply({ title: "入库", contextMode: "cumulative", owner: "甲", tasks: [{ seatId: "s1", instruction: "x" }] }),
        seats,
      ),
    ).toThrow(/第 1 阶段「入库」：多了不认识的字段 owner/);
    expect(() =>
      parseAgendaReply(
        reply({ title: "入库", contextMode: "cumulative", tasks: [{ seatId: "s1", instruction: "x", priority: 1 }] }),
        seats,
      ),
    ).toThrow(/第 1 阶段「入库」的第 1 条任务：多了不认识的字段 priority/);
  });
});
