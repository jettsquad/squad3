// 移植自 Squad 2.x packages/seat-codex/test/doing.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { codexTracker } from "../src/main/seats/codex/doing.ts";

// 事件形状取自真实的 `codex exec --json`（0.162）。
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const started = (id: string, command: string) =>
  line({ type: "item.started", item: { id, type: "command_execution", command, status: "in_progress" } });
const completed = (id: string, type = "command_execution", rest: Record<string, unknown> = {}) =>
  line({ type: "item.completed", item: { id, type, ...rest } });

describe("codexTracker", () => {
  it("命令开始时打开，同一个 id 完成时关上", () => {
    const tracker = codexTracker();
    tracker.feed(started("item_2", "/bin/zsh -lc 'sleep 4 && echo fg-done'"), 1000);
    expect(tracker.open()).toEqual([
      {
        id: "item_2",
        tool: "command_execution",
        command: "sleep 4 && echo fg-done",
        startedAt: 1000,
        background: false,
      },
    ]);
    tracker.feed(completed("item_2"));
    expect(tracker.open()).toEqual([]);
  });

  it("去掉 CLI 自己套的那层 shell，留下真正要跑的东西", () => {
    const tracker = codexTracker();
    tracker.feed(started("a", `/bin/bash -lc "pytest -q"`));
    tracker.feed(started("b", "git status"));
    expect(tracker.open().map((one) => one.command)).toEqual(["pytest -q", "git status"]);
  });

  it("模型说话和思考不算在跑的命令", () => {
    const tracker = codexTracker();
    tracker.feed(line({ type: "item.started", item: { id: "m", type: "agent_message" } }));
    tracker.feed(line({ type: "item.started", item: { id: "r", type: "reasoning" } }));
    expect(tracker.open()).toEqual([]);
  });

  it("记下它说的最后一句话", () => {
    const tracker = codexTracker();
    tracker.feed(completed("m1", "agent_message", { text: "先跑测试。" }));
    tracker.feed(completed("m2", "agent_message", { text: "测试在跑，等它结束。" }));
    expect(tracker.lastWords()).toBe("测试在跑，等它结束。");
  });

  it("没有命令文本的工作项，用它的类型当名字", () => {
    const tracker = codexTracker();
    tracker.feed(line({ type: "item.started", item: { id: "w", type: "mcp_tool_call" } }));
    expect(tracker.open()[0]?.command).toBe("mcp_tool_call");
  });
});

describe("Windows 上的命令外壳（Squad 3 新增）", () => {
  it("剥掉 powershell.exe -Command 外壳，只留要跑的命令", () => {
    const tracker = codexTracker();
    tracker.feed(
      `${JSON.stringify({
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'ping -n 15 127.0.0.1'`,
        },
      })}\n`,
    );
    expect(tracker.open()[0]?.command).toBe("ping -n 15 127.0.0.1");
  });
});
