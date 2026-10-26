// 移植自 Squad 2.x packages/seat-claude-code/test/doing.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { claudeTracker } from "../src/main/seats/claude-code/doing.ts";

// 下面的事件形状都是从真实的 `claude -p --output-format stream-json` 抓的（2.1.295）。
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const use = (id: string, input: Record<string, unknown>, name = "Bash") =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: string) =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const say = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const system = (subtype: string, rest: Record<string, unknown>) => line({ type: "system", subtype, ...rest });

describe("claudeTracker", () => {
  it("前台命令：调用时打开，返回时关上", () => {
    const tracker = claudeTracker();
    tracker.feed(use("t1", { command: "sleep 8" }), 1000);
    expect(tracker.open()).toEqual([
      { id: "t1", tool: "Bash", command: "sleep 8", startedAt: 1000, background: false },
    ]);
    tracker.feed(result("t1", "(Bash completed with no output)"), 9000);
    expect(tracker.open()).toEqual([]);
  });

  it("后台命令：工具调用立刻返回，但任务还开着", () => {
    // 就是这一条让一个跑全量测试的席位被当成卡死杀掉了两次：
    // 工具调用一秒内返回，之后这一轮一个字节都不写，只是在等。
    const tracker = claudeTracker();
    tracker.feed(use("t2", { command: "scripts/exit-check.sh RB0 --commit", run_in_background: true }), 1000);
    tracker.feed(system("background_tasks_changed", { tasks: [{ task_id: "b1", description: "run exit" }] }), 1001);
    tracker.feed(system("task_started", { task_id: "b1", tool_use_id: "t2", is_backgrounded: true }), 1002);
    tracker.feed(
      result(
        "t2",
        "Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b1.output. You will be notified.",
      ),
      1003,
    );
    tracker.feed(say("等待后台任务完成的通知。"), 1500);

    expect(tracker.open()).toHaveLength(1);
    expect(tracker.open()[0]).toMatchObject({
      id: "b1",
      command: "scripts/exit-check.sh RB0 --commit",
      background: true,
      outputFile: "/tmp/x/tasks/b1.output",
    });
    expect(tracker.lastWords()).toBe("等待后台任务完成的通知。");

    tracker.feed(system("task_notification", { task_id: "b1", status: "completed" }), 60_000);
    expect(tracker.open()).toEqual([]);
  });

  it("前台超时被挪到后台的命令，从任务列表里认出来", () => {
    // 它从没宣布过自己是后台任务：先是普通的前台调用，超时后工具调用返回，
    // 只有 CLI 重述的任务列表里还有它。
    const tracker = claudeTracker();
    tracker.feed(use("t3", { command: "uv run pytest -q" }), 1000);
    tracker.feed(system("task_started", { task_id: "b8", tool_use_id: "t3", is_backgrounded: false }), 1001);
    tracker.feed(
      result(
        "t3",
        "Command did not complete within its 600s timeout and was moved to the background (ID: b8). Output is being written to: /tmp/t/b8.output. You will be notified when it completes.",
      ),
      601_000,
    );
    tracker.feed(system("background_tasks_changed", { tasks: [{ task_id: "b8", description: "pytest" }] }), 601_001);

    expect(tracker.open()).toEqual([
      {
        id: "b8",
        tool: "Bash",
        command: "uv run pytest -q",
        startedAt: 1000,
        background: true,
        outputFile: "/tmp/t/b8.output",
      },
    ]);
  });

  it("任务列表是准的：列表里没有的就算结束了", () => {
    const tracker = claudeTracker();
    tracker.feed(system("background_tasks_changed", { tasks: [{ task_id: "b1", description: "一" }] }));
    tracker.feed(system("background_tasks_changed", { tasks: [{ task_id: "b2", description: "二" }] }));
    expect(tracker.open().map((one) => one.id)).toEqual(["b2"]);
    tracker.feed(system("background_tasks_changed", { tasks: [] }));
    expect(tracker.open()).toEqual([]);
  });

  it("task_updated 把任务改成结束状态，也算关上", () => {
    const tracker = claudeTracker();
    tracker.feed(system("task_started", { task_id: "b1", tool_use_id: "x", description: "跑", is_backgrounded: true }));
    tracker.feed(system("task_updated", { task_id: "b1", patch: { description: "改个名" } }));
    expect(tracker.open()).toHaveLength(1);
    tracker.feed(system("task_updated", { task_id: "b1", patch: { status: "completed" } }));
    expect(tracker.open()).toEqual([]);
  });

  it("不是 Bash 的工具，说清它指向什么", () => {
    const tracker = claudeTracker();
    tracker.feed(use("t1", { file_path: "/repo/a.ts" }, "Read"));
    tracker.feed(use("t2", { url: "https://example.com/x" }, "WebFetch"));
    expect(tracker.open().map((one) => one.command)).toEqual(["Read /repo/a.ts", "WebFetch https://example.com/x"]);
  });

  it("一行被切成两半喂进来，也只算一个事件", () => {
    // 看门狗每两秒读一次，管道里写到哪算哪。
    const tracker = claudeTracker();
    const whole = use("t1", { command: "make test" });
    tracker.feed(whole.slice(0, 40));
    expect(tracker.open()).toEqual([]);
    tracker.feed(whole.slice(40));
    expect(tracker.open()).toHaveLength(1);
  });

  it("很长的命令只留开头，换行压成一行", () => {
    const tracker = claudeTracker();
    tracker.feed(use("t1", { command: `echo a\necho b\n${"x".repeat(1000)}` }));
    const shown = tracker.open()[0]?.command ?? "";
    expect(shown.startsWith("echo a echo b ")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(301);
  });

  it("混进来的非 JSON 行不影响后面的事件", () => {
    const tracker = claudeTracker();
    tracker.feed("warning: something\n");
    tracker.feed(use("t1", { command: "ls" }));
    expect(tracker.open()).toHaveLength(1);
  });
});
