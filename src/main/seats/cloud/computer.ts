import { homedir } from "node:os";
import { CloudRpc } from "./rpc.ts";
import type { ResolvedCommand } from "../../seat-runtime/index.ts";

type ComputerAction = {
  action: "list_windows" | "observe" | "click" | "type_text" | "press_key" | "scroll";
  windowId?: number;
  app?: string;
  elementIndex?: number;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  scrollY?: number;
  screenshotId?: string;
};

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { content: Content[]; isError?: boolean };
export type ComputerApproval = (app: string, seatName: string) => Promise<boolean>;

/** The executor uses the locally configured computer-use MCP server without a model turn. */
export class ComputerExecutor {
  private rpc: CloudRpc | undefined;
  private threadId: string | undefined;
  private readonly blockedRequests: string[] = [];
  private readonly resolve: (name: string) => ResolvedCommand;
  private readonly cwd: string;
  private readonly approve: ComputerApproval | undefined;
  private readonly seatName: string;
  constructor(resolve: (name: string) => ResolvedCommand, cwd: string, approve?: ComputerApproval, seatName = "") {
    this.resolve = resolve;
    this.cwd = cwd;
    this.approve = approve;
    this.seatName = seatName;
  }

  async start(): Promise<void> {
    this.rpc = new CloudRpc(this.resolve("codex"), ["app-server", "--stdio"], this.cwd, {
      ...process.env,
      HOME: process.env["HOME"] ?? homedir(),
    });
    this.rpc.onMessage = (message) => {
      if (message.id !== undefined) {
        const id = message.id;
        const p = message.params;
        const meta = p?.["_meta"] as Record<string, unknown> | undefined;
        const details = meta?.["tool_params"] as Record<string, unknown> | undefined;
        const app = details?.["app"];
        if (
          message.method !== "mcpServer/elicitation/request" ||
          p?.["serverName"] !== "node_repl" ||
          p?.["threadId"] !== this.threadId ||
          p?.["mode"] !== "form" ||
          meta?.["connector_id"] !== "computer-use" ||
          typeof app !== "string" ||
          app.length > 500 ||
          this.approve === undefined
        ) {
          this.blockedRequests.push(message.method ?? "unknown");
          this.rpc?.send({ id, error: { code: -32601, message: "Approval unavailable" } });
          return;
        }
        void this.approve(app, this.seatName)
          .catch(() => false)
          .then((accepted) => {
            try {
              this.rpc?.send({
                id,
                result: {
                  action: accepted ? "accept" : "decline",
                  content: accepted ? {} : null,
                  _meta: { persist: "session" },
                },
              });
            } catch {
              // The task may have been cancelled while the dialog was open.
            }
          });
      }
    };
    await this.rpc.initialize();
    const thread = await this.rpc.request<{ thread: { id: string } }>("thread/start", {
      cwd: this.cwd,
      approvalPolicy: "on-request",
      sandbox: "read-only",
      ephemeral: true,
    });
    this.threadId = thread.thread.id;
    await this.run("if (!globalThis.sky) { const { sky } = await import('@oai/sky'); globalThis.sky = sky; }");
  }

  private async run(code: string): Promise<Result> {
    if (this.rpc === undefined || this.threadId === undefined) throw new Error("本机 Computer Use 尚未启动。");
    const result = await this.rpc.request<Result>(
      "mcpServer/tool/call",
      {
        threadId: this.threadId,
        server: "node_repl",
        tool: "js",
        arguments: { code, title: "Squad Computer Use" },
      },
      120000,
    );
    if (result.isError)
      throw new Error(
        result.content
          .map((item) => item.text ?? "")
          .join("\n")
          .slice(0, 1600) +
          (this.blockedRequests.length === 0 ? "" : `（本机请求：${this.blockedRequests.join(", ")}）`),
      );
    return result;
  }

  async call(input: ComputerAction): Promise<Result> {
    if (input.action === "list_windows") {
      return this.run(
        "globalThis.squadWindows = await sky.list_windows(); nodeRepl.write(JSON.stringify(squadWindows));",
      );
    }
    if (!Number.isSafeInteger(input.windowId) || typeof input.app !== "string" || input.app.length > 500) {
      throw new Error("请先列出窗口，并提供返回的窗口编号和应用标识。");
    }
    const window = JSON.stringify({ id: input.windowId, app: input.app });
    const select = `const w = (globalThis.squadWindows || []).find(x => x.id === ${input.windowId} && x.app === ${JSON.stringify(input.app)}); if (!w) throw new Error("请重新列出窗口"); if (/(powershell|cmd\\.exe|terminal|conhost|regedit|security|credential|password|lockapp|codex)/i.test(w.app + " " + (w.title || ""))) throw new Error("该窗口不允许自动操作");`;
    switch (input.action) {
      case "observe":
        return this.run(
          `${select} globalThis.squadState = await sky.get_window_state({window:w,include_screenshot:true,include_text:true}); nodeRepl.write(JSON.stringify({window:squadState.window,accessibility:squadState.accessibility,screenshots:squadState.screenshots.map(({url,...rest})=>rest)}));`,
        );
      case "click":
        if (!Number.isSafeInteger(input.elementIndex) && !(Number.isFinite(input.x) && Number.isFinite(input.y)))
          throw new Error("点击位置无效。");
        return this.run(
          `${select} if (!globalThis.squadState || squadState.window.id !== w.id) throw new Error("请先观察目标窗口"); await sky.click(${JSON.stringify({ window: JSON.parse(window), element_index: input.elementIndex, x: input.x, y: input.y, screenshotId: input.screenshotId })}); globalThis.squadState = undefined; nodeRepl.write("点击完成");`,
        );
      case "type_text":
        if (typeof input.text !== "string" || input.text.length > 10000) throw new Error("输入文本无效。");
        return this.run(
          `${select} if (!globalThis.squadState || squadState.window.id !== w.id) throw new Error("请先观察目标窗口"); await sky.type_text({window:w,text:${JSON.stringify(input.text)}}); globalThis.squadState = undefined; nodeRepl.write("输入完成");`,
        );
      case "press_key":
        if (
          typeof input.key !== "string" ||
          input.key.length > 80 ||
          /(^|\+)(win|windows|meta|super|cmd)(\+|$)/i.test(input.key)
        )
          throw new Error("按键无效。");
        return this.run(
          `${select} if (!globalThis.squadState || squadState.window.id !== w.id) throw new Error("请先观察目标窗口"); await sky.press_key({window:w,key:${JSON.stringify(input.key)}}); globalThis.squadState = undefined; nodeRepl.write("按键完成");`,
        );
      case "scroll":
        if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || !Number.isFinite(input.scrollY))
          throw new Error("滚动参数无效。");
        return this.run(
          `${select} if (!globalThis.squadState || squadState.window.id !== w.id) throw new Error("请先观察目标窗口"); await sky.scroll({window:w,x:${input.x},y:${input.y},scrollX:0,scrollY:${input.scrollY}}); globalThis.squadState = undefined; nodeRepl.write("滚动完成");`,
        );
      default:
        throw new Error("不支持的 Computer Use 操作。");
    }
  }

  async close(): Promise<void> {
    await this.rpc?.close();
  }
}
