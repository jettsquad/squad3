// 移植自 Squad 2.x packages/table/test/commands.test.ts @ 8dcb903
/**
 * 命令并行的规则。
 *
 * 这几条错了都很安静：席位串着跑只是慢，同一个席位被同时派两条只是它的对话
 * 少记了一段，窗口里多带了待答的指令只是它答得早了一步——每一种看上去都像
 * 模型的毛病，而不是调度的毛病。所以钉死在这里。
 */
import { describe, expect, it } from "vitest";
import {
  firstLine,
  CUT_SHORT_MARK,
  cutShort,
  excerpt,
  excludedFor,
  replyTag,
  settled,
  startable,
  type CommandSeatState,
  type CommandSlot,
  type CommandState,
} from "../src/main/table/commands.ts";

const command = (
  commandId: string,
  seats: Record<string, CommandSeatState>,
  state: CommandState = "queued",
): CommandSlot => ({
  commandId,
  state,
  seatIds: Object.keys(seats),
  seats: new Map(Object.entries(seats)),
});

describe("startable", () => {
  it("点名不同席位的两条命令同时开工", () => {
    // 原来一张桌子同一时刻只跑一轮：发给 B 的命令要等 A 答完才动。
    const turns = startable([command("c1", { a: "queued" }), command("c2", { b: "queued" })], new Set());
    expect(turns).toEqual([
      { commandId: "c1", seatId: "a" },
      { commandId: "c2", seatId: "b" },
    ]);
  });

  it("一条命令点名多个席位，各席位同时开工", () => {
    const turns = startable([command("c1", { a: "queued", b: "queued" })], new Set());
    expect(turns.map((turn) => turn.seatId)).toEqual(["a", "b"]);
  });

  it("同一个席位的命令按发出的顺序一条一条来", () => {
    // 席位续接的是同一个 CLI 对话，两条同时续接会互相看不见，事后只记得住一条。
    const turns = startable([command("c1", { a: "queued" }), command("c2", { a: "queued" })], new Set());
    expect(turns).toEqual([{ commandId: "c1", seatId: "a" }]);
  });

  it("席位忙着的时候不接新命令，别的席位照常开工", () => {
    const turns = startable(
      [command("c1", { a: "running" }, "running"), command("c2", { a: "queued", b: "queued" })],
      new Set(["a"]),
    );
    expect(turns).toEqual([{ commandId: "c2", seatId: "b" }]);
  });

  it("后发的命令不会插到同一席位更早的命令前面", () => {
    // c1 在 a 上排队、b 已经答完；c2 也点了 a。a 一空出来接的必须是 c1。
    const turns = startable(
      [command("c1", { a: "queued", b: "answered" }, "running"), command("c2", { a: "queued" })],
      new Set(),
    );
    expect(turns).toEqual([{ commandId: "c1", seatId: "a" }]);
  });

  it("已经结束、被叫停或中断的命令不再派活", () => {
    for (const state of ["done", "stopped", "interrupted"] as const) {
      expect(startable([command("c1", { a: "queued" }, state)], new Set())).toEqual([]);
    }
  });
});

describe("excludedFor", () => {
  it("正在答的那条命令不进窗口", () => {
    // 它以「本轮指令」的身份送到席位手上，窗口里再出现一次就是读两遍。
    const commands = [command("c1", { a: "running" }, "running")];
    expect(excludedFor(commands, "a", "c1")).toEqual(["c1"]);
  });

  it("排在这个席位后面、还没轮到的命令也不进窗口", () => {
    // 否则席位会提前把下一条也答了，轮到它时再答一遍。
    const commands = [command("c1", { a: "running" }, "running"), command("c2", { a: "queued" })];
    expect(excludedFor(commands, "a", "c1")).toEqual(["c1", "c2"]);
  });

  it("发给别的席位的命令照常进窗口", () => {
    const commands = [command("c1", { a: "running" }, "running"), command("c2", { b: "queued" })];
    expect(excludedFor(commands, "a", "c1")).toEqual(["c1"]);
  });

  it("这个席位已经答完的命令照常进窗口", () => {
    const commands = [command("c0", { a: "answered" }, "done"), command("c1", { a: "running" }, "running")];
    expect(excludedFor(commands, "a", "c1")).toEqual(["c1"]);
  });
});

describe("settled", () => {
  it("还有席位在排队或在答，就没结束", () => {
    expect(
      settled(
        new Map([
          ["a", "answered"],
          ["b", "running"],
        ]),
      ),
    ).toBe(false);
    expect(
      settled(
        new Map([
          ["a", "stopped"],
          ["b", "queued"],
        ]),
      ),
    ).toBe(false);
  });

  it("每个席位都有了结果就结束", () => {
    expect(
      settled(
        new Map<string, CommandSeatState>([
          ["a", "answered"],
          ["b", "failed"],
          ["c", "stopped"],
        ]),
      ),
    ).toBe(true);
  });
});

describe("replyTag", () => {
  const at = new Date(2026, 9, 2, 22, 5).getTime();

  it("中间没有插进别的命令，就不加标注", () => {
    // 回复紧跟着它自己的命令，记录跟以前一模一样。
    expect(replyTag({ seq: 3, at, instruction: "是否与程序一致？" }, 3)).toBe("");
  });

  it("插进了别的命令，就标明答的是哪一条", () => {
    expect(replyTag({ seq: 3, at, instruction: "是否与程序一致？是否有缺失？" }, 4)).toBe(
      "（答 22:05「是否与程序一致？是否有缺失？」）\n",
    );
  });

  it("长指令只取开头", () => {
    expect(excerpt("一二三四五六七八九十一二三四五六七八九十多出来的")).toBe(
      "一二三四五六七八九十一二三四五六七八九十…",
    );
    expect(excerpt("换行\n\n也  压成一行")).toBe("换行 也 压成一行");
  });
});

describe("cutShort", () => {
  it("被叫停时已经说了半句的，标明没答完", () => {
    // 真实的一次：叫停后记录里留下「我先读两份文档的实际内容再评审。」，
    // 看上去像这位成员就这么一句话的意见。
    expect(cutShort("我先读两份文档的实际内容再评审。")).toBe(`我先读两份文档的实际内容再评审。\n\n${CUT_SHORT_MARK}`);
  });

  it("末尾的空白不夹在正文和标注之间", () => {
    expect(cutShort("说到一半\n\n  ")).toBe(`说到一半\n\n${CUT_SHORT_MARK}`);
  });

  it("一个字都没说的不标——那种情况另有一行「被叫停，没有答复」", () => {
    expect(cutShort("")).toBe("");
    expect(cutShort("  \n")).toBe("  \n");
  });
});

describe("firstLine", () => {
  it("取失败回复里第一句说了原因的话，去掉前面的警示符号", () => {
    expect(firstLine("\n\n  ⚠️ 这个席位连续 15 分钟没有任何新输出，判定为卡死。\n判据是静默")).toBe(
      "这个席位连续 15 分钟没有任何新输出，判定为卡死。",
    );
  });

  it("以冒号结尾的那行只是在报幕，原因在它后面", () => {
    // 真实跑出来的就是这个：审计里写着「没有完成（该席位没有给出答复：）」，等于没说。
    expect(firstLine("⚠️ 该席位没有给出答复：\ndsh: MISSING_CREDENTIAL: no credential")).toBe(
      "dsh: MISSING_CREDENTIAL: no credential",
    );
    expect(firstLine("只有这一行：")).toBe("只有这一行：");
  });

  it("太长就截断，空的就照实说没有原因", () => {
    expect(firstLine("长".repeat(300))).toHaveLength(121);
    expect(firstLine("  \n ")).toBe("没有给出原因");
  });
});
