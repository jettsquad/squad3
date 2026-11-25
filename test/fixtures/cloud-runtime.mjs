// Protocol double only. Never executes a supplied command or uses a network connection.
import readline from "node:readline";
import { createContext, runInContext } from "node:vm";
const role = process.argv[2];
const flavor = process.argv[3] || "chat";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let thread = "test-cloud-thread";
let turn = 0;
let approvalCall;
let counter = 0;
let written = "";
const fixtureWindow = { id: 123, app: "fixture.exe", title: "Fixture" };
const replContext =
  flavor === "computer-repl-scope"
    ? createContext({
        sky: {
          list_windows: async () => [fixtureWindow, { id: 124, app: "other.exe", title: "Other" }],
          get_window_state: async (input) => ({
            window: input.window,
            accessibility: { tree: `Count: ${counter}` },
            screenshots: [{ id: "screenshot-0", url: "fixture", width: 100, height: 100 }],
          }),
          click: async ({ screenshotId, x, y }) => {
            if (screenshotId !== "screenshot-0" || x !== 10 || y !== 10) throw Error("Wrong screenshot or coordinates");
            counter++;
          },
        },
        nodeRepl: { write: (value) => (written = value) },
      })
    : undefined;
function complete(text) {
  send({ method: "item/agentMessage/delta", params: { threadId: thread, delta: text } });
  send({ method: "turn/completed", params: { threadId: thread, turn: { status: "completed" } } });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (role === "local" && m.id === "approval-1" && !m.method) {
    const approved = m.result?.action === "accept";
    send({
      id: approvalCall,
      result: {
        isError: !approved,
        content: [
          { type: "text", text: approved ? "FIXTURE_APPROVED" : "Computer Use was not approved to use fixture" },
        ],
      },
    });
    return;
  }
  if (m.id === "tool-1" && !m.method) {
    const text = m.result?.contentItems?.[0]?.text || "NO_RESULT";
    complete(text);
    return;
  }
  if (!m.method || m.method === "initialized") return;
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "thread/start" || m.method === "thread/resume") {
    if (flavor === "missing" && m.method === "thread/resume")
      send({ id: m.id, error: { code: -32600, message: "thread not found" } });
    else send({ id: m.id, result: { thread: { id: thread }, approvalPolicy: m.params?.approvalPolicy } });
  } else if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn-" + ++turn } } });
    send({ method: "turn/started", params: { threadId: thread, turn: { id: "turn-" + turn } } });
    if (flavor === "wait") return;
    if (flavor === "computer" || flavor === "computer-auto" || flavor === "computer-click")
      send({
        id: "tool-1",
        method: "item/tool/call",
        params: {
          threadId: thread,
          turnId: "turn-" + turn,
          callId: "stable-call",
          tool: "workstation_computer",
          arguments:
            flavor !== "computer-click"
              ? { action: "list_windows" }
              : { action: "click", windowId: 123, app: "fixture.exe", elementIndex: 1 },
        },
      });
    else if (flavor === "tool")
      send({
        id: "tool-1",
        method: "item/tool/call",
        params: {
          threadId: thread,
          turnId: "turn-" + turn,
          callId: "stable-call",
          tool: "workstation_shell",
          arguments: { command: "Read fixture", timeoutMs: 1000 },
        },
      });
    else if (flavor === "fail")
      send({
        method: "turn/completed",
        params: { threadId: thread, turn: { status: "failed", error: { message: "remote account unavailable" } } },
      });
    else complete("REMOTE_ONLY");
  } else if (m.method === "mcpServer/tool/call" && role === "local") {
    const code = m.params.arguments.code;
    if (replContext) {
      written = "";
      // Model the REPL warning for a declaration at cell scope. Evaluate only the
      // Windows snippets produced by the regression test's ComputerExecutor.
      if (code.startsWith("const w =")) {
        send({ id: m.id, result: { content: [{ type: "text", text: "Unexpected top-level declaration" }] } });
      } else {
        const evaluated = runInContext(`(async () => { ${code} })()`, replContext);
        void evaluated.then(
          () => send({ id: m.id, result: { content: [{ type: "text", text: written }] } }),
          (e) => send({ id: m.id, result: { isError: true, content: [{ type: "text", text: e.message }] } }),
        );
      }
    } else if (flavor === "computer-approval" && code.includes("list_windows")) {
      approvalCall = m.id;
      send({
        id: "approval-1",
        method: "mcpServer/elicitation/request",
        params: {
          threadId: thread,
          serverName: "node_repl",
          mode: "form",
          _meta: { connector_id: "computer-use", tool_params: { app: "fixture.exe" } },
          message: "Allow?",
          requestedSchema: { type: "object", properties: {} },
        },
      });
    } else
      send({
        id: m.id,
        result: {
          content: [
            {
              type: "text",
              text: m.params.arguments.code.includes("list_windows") ? "FIXTURE_WINDOWS" : "INITIALIZED",
            },
          ],
        },
      });
  } else if (m.method === "command/exec" && role === "local") {
    send({
      id: m.id,
      result: {
        exitCode: 0,
        stdout: JSON.stringify({
          local: true,
          cwd: m.params.cwd,
          policy: m.params.sandboxPolicy,
          secretLeaked: !!process.env.SQUAD_CLOUD_TEST_SECRET,
        }),
        stderr: "",
      },
    });
  } else send({ id: m.id, result: {} });
});
