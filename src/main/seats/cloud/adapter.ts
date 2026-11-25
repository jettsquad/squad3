import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { checkConnection, type SeatConnection } from "../../../shared/connection.ts";
import type { SeatUsage } from "../../../shared/seat-usage.ts";
import type { MethodOutput } from "../../../shared/wire.ts";
import { refusedRun, type ResolvedCommand, type SeatResult, type SeatRun } from "../../seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest } from "../types.ts";
import { CloudRpc, type RpcMessage } from "./rpc.ts";
import { ComputerExecutor, type ComputerApproval } from "./computer.ts";

type CommandResolver = (name: string) => ResolvedCommand;
interface ThreadReply {
  readonly thread: { readonly id: string };
  readonly approvalPolicy?: string;
}
interface ToolCall {
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
}
interface ToolReply {
  readonly success: boolean;
  readonly contentItems: readonly (
    { readonly type: "inputText"; readonly text: string } | { readonly type: "inputImage"; readonly imageUrl: string }
  )[];
}
interface ExecReply {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const SHELL_TOOL = {
  type: "function",
  name: "workstation_shell",
  description:
    "Execute a command on the user's local workstation in the team's project directory, under the seat's existing permission and network settings. Windows uses PowerShell, other hosts use /bin/sh. Cloud filesystem paths are not workstation paths. Do not retry commands with unknown effects.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1, maxLength: 32000 },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
    },
    required: ["command"],
    additionalProperties: false,
  },
};
const IMAGE_TOOL = {
  type: "function",
  name: "workstation_image",
  description:
    "Read a selected project image on the workstation as image bytes; never use a local Windows path as a cloud image URL. Maximum 1 MiB.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};
const COMPUTER_TOOL = {
  type: "function",
  name: "workstation_computer",
  description:
    "Use the local Windows Computer Use interface. First list_windows, then observe a listed window before each click, type_text, press_key or scroll. For every action except list_windows, pass both windowId (the listed id) and app (the exact listed app). The observation returns accessibility text and screenshots. Click coordinates are pixels relative to the screenshot's top-left; do not add originX or originY. For a single screenshot omit screenshotId; for multiple screenshots copy the chosen id exactly. Do not use terminal, authentication or security windows.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list_windows", "observe", "click", "type_text", "press_key", "scroll"] },
      windowTitle: {
        type: "string",
        description: "Optional exact title for list_windows; only matching windows are returned.",
      },
      windowId: { type: "integer" },
      app: { type: "string" },
      elementIndex: { type: "integer" },
      x: { type: "number", description: "Horizontal pixels from the screenshot's left edge, not a screen coordinate." },
      y: { type: "number", description: "Vertical pixels from the screenshot's top edge, not a screen coordinate." },
      text: { type: "string" },
      key: { type: "string" },
      scrollY: { type: "number" },
      screenshotId: { type: "string" },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

const CLOUD_REASONING_CONFIG = {
  features: {
    shell_tool: false,
    hooks: false,
    plugins: false,
    apps: false,
    multi_agent: false,
    multi_agent_v2: false,
    view_image: false,
  },
  web_search: "disabled",
  mcp_servers: {},
};
const CLOUD_NATIVE_TOOL_ITEMS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "collabAgentToolCall",
  "collabToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

/** Stable scope: changing a connection/profile/account revision cannot resume its old thread. */
export function cloudScope(connection: SeatConnection, cwd: string, seatId: string, scene?: string): string {
  const { quotaProvider: _quotaProvider, ...profile } = connection.cloud ?? {};
  return createHash("sha256")
    .update(
      JSON.stringify([
        "workstation-harness-v1",
        connection.connectionId,
        connection.cloud === undefined ? undefined : profile,
        connection.modelId,
        cwd,
        seatId,
        scene,
      ]),
    )
    .digest("hex");
}

export function cloudResume(id: string | undefined, scope: string): string | undefined {
  if (id === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(id, "base64url").toString()) as { scope?: string; thread?: string };
    return value.scope === scope && typeof value.thread === "string" && /^[\w-]{1,150}$/.test(value.thread)
      ? value.thread
      : undefined;
  } catch {
    return undefined;
  }
}

/** Strict SSH host verification. The only remote command is a validated executable and user. */
export function cloudSshArgs(
  connection: SeatConnection,
  operation: "agent" | "quota" | "status" | "subscription" | "subscribe-month" | "subscribe-year" = "agent",
): readonly string[] {
  const problems = checkConnection(connection);
  if (problems.length > 0) throw new Error(problems.map((p) => p.detail).join("\n"));
  const c = connection.cloud;
  if (c === undefined) throw new Error("没有云端连接配置。");
  return [
    "-T",
    "-i",
    c.identityFile,
    "-p",
    String(c.port),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    ...(c.managedDeviceId === undefined
      ? []
      : ["-F", "none", "-o", "GlobalKnownHostsFile=none", "-o", "HostKeyAlgorithms=ssh-ed25519"]),
    "-o",
    `UserKnownHostsFile=${c.knownHostsFile}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    `${c.user}@${c.host}`,
    c.managedDeviceId !== undefined
      ? `squad-${operation}`
      : operation === "agent"
        ? `exec runuser -u ${c.runAs} -- timeout 1800 ${c.executable} app-server --stdio`
        : `exec runuser -u ${c.runAs} -- timeout 15 ${c.executable} squad-quota`,
  ];
}

const quotaWindows = z
  .array(
    z.object({
      label: z.string().min(1).max(120),
      remainingPercent: z.number().min(0).max(100),
      resetsAt: z.number().positive().optional(),
    }),
  )
  .min(1)
  .max(20);

function sshEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: homedir() };
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "SystemDrive",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USERDOMAIN",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "COMSPEC",
    "ProgramData",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function readCloudQuota(
  connection: SeatConnection,
  resolveCommand: CommandResolver,
): Promise<MethodOutput<"connections.quota">> {
  const provider = connection.cloud?.quotaProvider;
  if (connection.source !== "octopus" || provider === undefined) throw new Error("请先设置云端额度来源。");
  const ssh = resolveCommand("ssh");
  if (provider === "minimax") {
    try {
      const { stdout } = await promisify(execFile)(
        ssh.file,
        [...ssh.prefixArgs, ...cloudSshArgs(connection, "quota")],
        {
          windowsHide: true,
          timeout: 20000,
          maxBuffer: 32768,
          env: { ...sshEnvironment(), ...ssh.env },
        },
      );
      return { checkedAt: Date.now(), windows: quotaWindows.parse(JSON.parse(stdout)) };
    } catch {
      throw new Error("无法查询 MiniMax 订阅额度。请检查云端额度查询程序和订阅 Key。");
    }
  }
  const rpc = new CloudRpc(ssh, cloudSshArgs(connection), homedir(), sshEnvironment());
  try {
    await rpc.initialize(15000);
    const window = z
      .object({
        usedPercent: z.number().min(0),
        windowDurationMins: z.number().positive().nullish(),
        resetsAt: z.number().positive().nullish(),
      })
      .nullish();
    const bucket = z.object({ limitName: z.string().nullish(), primary: window, secondary: window });
    const data = z
      .object({
        rateLimits: bucket,
        rateLimitsByLimitId: z.record(z.string(), bucket).nullish(),
      })
      .parse(await rpc.request("account/rateLimits/read", {}, 15000));
    const buckets = Object.entries(data.rateLimitsByLimitId ?? {});
    const windows = (buckets.length ? buckets : ([["Codex", data.rateLimits]] as const)).flatMap(([id, entry]) =>
      [entry.primary, entry.secondary].flatMap((value, index) =>
        value == null
          ? []
          : [
              {
                label: `${entry.limitName || id} · ${value.windowDurationMins ?? (index === 0 ? "primary" : "secondary")}${value.windowDurationMins == null ? "" : " min"}`,
                remainingPercent: Math.max(0, 100 - value.usedPercent),
                resetsAt: value.resetsAt == null ? undefined : value.resetsAt * 1000,
              },
            ],
      ),
    );
    return { checkedAt: Date.now(), windows: quotaWindows.parse(windows) };
  } catch {
    throw new Error("无法查询 Codex 订阅额度。请检查云端 ChatGPT 登录和网络。");
  } finally {
    await rpc.close();
  }
}

function textResult(text: string, success: boolean): ToolReply {
  return { success, contentItems: [{ type: "inputText", text }] };
}

/** JSON does not leave this module except as the vendor's documented app-server protocol. */
export function createCloudAdapter(options: {
  readonly stateDir: string;
  readonly resolve: CommandResolver;
  readonly active?: Set<string>;
  readonly approveComputer?: ComputerApproval | undefined;
}): SeatAdapter {
  return {
    backend: "codex",
    capabilities: { persona: false, resume: true },
    start(request): SeatRun {
      const connection = request.connection?.connection;
      if (connection?.source !== "octopus") return refusedRun("没有选择云端来源。");
      const problems = checkConnection(connection);
      if (problems.length > 0) return refusedRun(problems.map((p) => p.detail).join("\n"));
      const mode = request.seat.permissionMode ?? "workspace";
      if (!["read-only", "workspace", "yolo"].includes(mode)) return refusedRun(`Codex 没有「${mode}」这种权限模式。`);
      // These are options for other execution paths: hostCustomizations is a
      // Claude setting, and native cloud subagents remain disabled on this route.
      // Existing templates can carry either value; neither changes the local Harness.
      if (request.persona !== undefined) return refusedRun("云端 Codex 的 persona 应合入 prompt。");
      let cwd: string;
      try {
        cwd = realpathSync(request.cwd);
      } catch {
        return refusedRun("团队项目文件夹不存在。");
      }
      const scope = cloudScope(connection, cwd, request.seat.seatId, request.sessionScope);
      const resumed = cloudResume(request.resumeId, scope);
      if (request.resumeId !== undefined && resumed === undefined)
        return {
          result: Promise.resolve({
            text: "云端连接配置已改变，正在重建上下文。",
            failed: true,
            cancelled: false,
            resetSession: true,
            exitCode: null,
            durationMs: 0,
          }),
          cancel: () => undefined,
        };
      return runCloud({ ...request, cwd }, connection, scope, resumed, options);
    },
  };
}

function runCloud(
  request: SeatRequest,
  connection: SeatConnection,
  scope: string,
  resumed: string | undefined,
  options: {
    readonly stateDir: string;
    readonly resolve: CommandResolver;
    readonly active?: Set<string>;
    readonly approveComputer?: ComputerApproval | undefined;
  },
): SeatRun {
  const started = Date.now();
  let cloud: CloudRpc | undefined;
  let local: CloudRpc | undefined;
  let computer: ComputerExecutor | undefined;
  let localReady: Promise<CloudRpc> | undefined;
  let cancelled = false;
  let ended = false;
  let text = "";
  let threadId: string | undefined;
  let turnId: string | undefined;
  let received = 0;
  let toolCount = 0;
  let usage: SeatUsage | undefined;
  let counters = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let baseline = { ...counters };
  if (resumed !== undefined && request.resumeId !== undefined) {
    try {
      baseline =
        (JSON.parse(Buffer.from(request.resumeId, "base64url").toString()) as { counters?: typeof counters })
          .counters ?? baseline;
    } catch {
      /* Scope validation already rejected malformed handles. */
    }
  }
  let localHome: string | undefined;
  let lockHeld = false;
  let uncertain = false;
  let inFlight = false;
  let failure: Error | undefined;
  let cloudPolicyFailure: Error | undefined;
  const actions = new Map<string, { digest: string; result: Promise<ToolReply> }>();
  let settleTurn: (() => void) | undefined;
  let rejectTurn: ((e: Error) => void) | undefined;
  const lockFile = join(
    options.stateDir,
    "cloud-pending",
    createHash("sha256").update(request.cwd).digest("hex") + ".json",
  );
  const activity = (command?: string): void =>
    request.onActivity?.({
      received,
      open:
        command === undefined
          ? []
          : [
              {
                id: "local",
                tool: "workstation_shell",
                startedAt: Date.now(),
                background: false,
                command: command.slice(0, 160),
              },
            ],
      ...(text === "" ? {} : { lastWords: text.slice(-200) }),
    });
  const stop = (): void => {
    if (ended || cancelled) return;
    cancelled = true;
    if (inFlight) uncertain = true;
    local?.close();
    void computer?.close();
    if (threadId !== undefined && turnId !== undefined)
      void cloud?.request("turn/interrupt", { threadId, turnId }, 3000).catch(() => undefined);
    else void cloud?.close();
    rejectTurn?.(new Error("云端席位已取消；已开始的本地操作请核对实际结果。"));
  };

  async function executor(): Promise<CloudRpc> {
    if (localReady !== undefined) return localReady;
    localReady = prepareExecutor();
    return localReady;
  }

  async function prepareExecutor(): Promise<CloudRpc> {
    localHome = join(options.stateDir, "cloud-executor", randomUUID());
    mkdirSync(localHome, { recursive: true });
    // Only this executor's runtime configuration. Existing local CLI logins/config are untouched.
    writeFileSync(
      join(localHome, "config.toml"),
      process.platform === "win32" ? '[windows]\nsandbox = "unelevated"\n' : "",
      { mode: 0o600 },
    );
    const env: NodeJS.ProcessEnv = { CODEX_HOME: localHome };
    for (const k of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT", "COMSPEC", "LANG"])
      if (process.env[k] !== undefined) env[k] = process.env[k];
    local = new CloudRpc(options.resolve("codex"), ["app-server", "--stdio"], request.cwd, env);
    local.onMessage = (m) => {
      if (m.id !== undefined)
        local?.send({ id: m.id, error: { code: -32601, message: "No permission escalation from remote tools" } });
    };
    await local.initialize();
    return local;
  }

  async function tool(call: ToolCall): Promise<ToolReply> {
    if (cancelled || ended || uncertain || cloudPolicyFailure !== undefined)
      return textResult("本地执行已停止或需要核对，不允许继续。", false);
    if (call.threadId !== threadId || call.turnId !== turnId) return textResult("工具调用不属于当前回合。", false);
    if (++toolCount > 40) return textResult("本轮超过 40 次工具调用上限。", false);
    if (call.tool === "workstation_computer") {
      if ((request.seat.permissionMode ?? "workspace") !== "yolo")
        return textResult("Computer Use 需要席位的完全访问权限；当前权限未改变。", false);
      if (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments))
        return textResult("Computer Use 参数无效。", false);
      if (!/^[\w-]{1,200}$/.test(call.callId)) return textResult("工具调用编号无效。", false);
      const input = call.arguments as Parameters<ComputerExecutor["call"]>[0];
      if (
        input.action !== "list_windows" &&
        (!Number.isSafeInteger(input.windowId) || typeof input.app !== "string" || input.app.length > 500)
      )
        return textResult("请先列出窗口，并同时提供返回的 windowId 和 app。没有执行任何操作。", false);
      const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const previous = actions.get(call.callId);
      if (previous !== undefined)
        return previous.digest === digest ? previous.result : textResult("调用参数不一致。", false);
      const result = (async (): Promise<ToolReply> => {
        if (inFlight) return textResult("上一个本地工具仍在执行。", false);
        const readOnly = input.action === "list_windows" || input.action === "observe";
        if (!readOnly) mkdirSync(join(options.stateDir, "cloud-pending"), { recursive: true });
        if (!readOnly && !lockHeld) {
          try {
            const fd = openSync(lockFile, "wx", 0o600);
            closeSync(fd);
          } catch {
            return textResult(
              `该项目有未结算的云端工具记录，请在 Squad 左侧「待处理」核对后再操作：${lockFile}。`,
              false,
            );
          }
          lockHeld = true;
          options.active?.add(lockFile);
        }
        inFlight = true;
        try {
          if (!readOnly)
            writeFileSync(
              lockFile,
              JSON.stringify({
                at: Date.now(),
                project: request.cwd,
                scope,
                callId: call.callId,
                digest,
                state: "pending",
              }),
              { mode: 0o600 },
            );
          if (computer === undefined) {
            computer = new ComputerExecutor(
              options.resolve,
              request.cwd,
              request.seat.computerAccess === true ? async () => true : options.approveComputer,
              request.seat.displayName,
            );
            await computer.start();
          }
          const response = await computer.call(input);
          const items: ToolReply["contentItems"][number][] = [];
          for (const item of response.content) {
            if (item.type === "text" && typeof item.text === "string")
              items.push({ type: "inputText", text: item.text.slice(0, 50000) });
            if (
              item.type === "image" &&
              typeof item.data === "string" &&
              /^image\/(png|jpeg|webp)$/.test(item.mimeType ?? "")
            )
              items.push({ type: "inputImage", imageUrl: `data:${item.mimeType};base64,${item.data}` });
          }
          if (!readOnly)
            writeFileSync(
              lockFile,
              JSON.stringify({
                at: Date.now(),
                project: request.cwd,
                scope,
                callId: call.callId,
                digest,
                state: "completedAwaitingCloud",
                exitCode: 0,
                stdout: "Computer Use 操作已返回。",
              }),
              { mode: 0o600 },
            );
          return {
            success: true,
            contentItems: items.length > 0 ? items : [{ type: "inputText", text: "操作完成。" }],
          };
        } catch (e) {
          if (/Computer Use was not approved/i.test(errorText(e))) {
            return textResult(`本机 Computer Use 未授权此窗口，未执行操作：${errorText(e)}`, false);
          }
          if (input.action === "list_windows" || input.action === "observe") {
            return textResult(`Computer Use 读取失败：${errorText(e)}`, false);
          }
          uncertain = true;
          return textResult(`Computer Use 调用未确认，请核对本地状态：${errorText(e)}`, false);
        } finally {
          inFlight = false;
        }
      })();
      actions.set(call.callId, { digest, result });
      return result;
    }
    if (call.threadId === threadId && call.tool === "workstation_image") {
      try {
        const p = call.arguments as Record<string, unknown>;
        if (typeof p?.["path"] !== "string" || Object.keys(p).some((k) => k !== "path"))
          throw new Error("图片参数不合法。");
        const file = realpathSync(resolve(request.cwd, p["path"]));
        const project = realpathSync(request.cwd);
        const normalized = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s);
        if (!normalized(file).startsWith(normalized(project + sep))) throw new Error("图片不在团队项目目录内。");
        const mime = (
          { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<
            string,
            string
          >
        )[extname(file).toLowerCase()];
        if (mime === undefined || !statSync(file).isFile() || statSync(file).size > 1024 * 1024)
          throw new Error("仅支持不超过 1 MiB 的 PNG/JPEG/WebP 图片。");
        return {
          success: true,
          contentItems: [
            { type: "inputImage", imageUrl: `data:${mime};base64,${readFileSync(file).toString("base64")}` },
          ],
        };
      } catch (e) {
        return textResult(errorText(e), false);
      }
    }
    if (call.threadId !== threadId || call.tool !== "workstation_shell" || !/^[\w-]{1,200}$/.test(call.callId))
      return textResult("工具不在当前席位作用域中。", false);
    const args = call.arguments;
    if (typeof args !== "object" || args === null || Array.isArray(args))
      return textResult("工具参数必须是对象。", false);
    const p = args as Record<string, unknown>;
    const timeoutMs = p["timeoutMs"] ?? 60000;
    if (
      typeof p["command"] !== "string" ||
      p["command"].trim() === "" ||
      p["command"].length > 32000 ||
      !Number.isInteger(timeoutMs) ||
      Number(timeoutMs) < 1000 ||
      Number(timeoutMs) > 120000 ||
      Object.keys(p).some((k) => !["command", "timeoutMs"].includes(k))
    )
      return textResult("命令或超时参数不合法。", false);
    const command = p["command"];
    const digest = createHash("sha256")
      .update(JSON.stringify([command, timeoutMs]))
      .digest("hex");
    const previous = actions.get(call.callId);
    if (previous !== undefined)
      return previous.digest === digest ? previous.result : textResult("同一调用 ID 的参数不一致。", false);
    const result = (async (): Promise<ToolReply> => {
      if (inFlight) return textResult("上一个本地工具仍在执行，请等待结果。", false);
      const runtime = await executor();
      if (cancelled) return textResult("已取消，没有执行命令。", false);
      if (inFlight) return textResult("上一个本地工具仍在执行，请等待结果。", false);
      mkdirSync(join(options.stateDir, "cloud-pending"), { recursive: true });
      if (!lockHeld) {
        let fd: number;
        try {
          fd = openSync(lockFile, "wx", 0o600);
        } catch {
          return textResult(`该项目有未结算的云端工具记录，先核对 ${lockFile}，不要重试命令。`, false);
        }
        try {
          writeFileSync(
            fd,
            JSON.stringify({
              at: Date.now(),
              project: request.cwd,
              scope,
              callId: call.callId,
              digest,
              state: "pending",
            }),
          );
        } finally {
          closeSync(fd);
        }
        lockHeld = true;
        options.active?.add(lockFile);
      }
      inFlight = true;
      // Update the retained guard for every action, not only the first one in a turn.
      try {
        writeFileSync(
          lockFile,
          JSON.stringify({
            at: Date.now(),
            project: request.cwd,
            scope,
            callId: call.callId,
            digest,
            state: "pending",
          }),
          { mode: 0o600 },
        );
      } catch (e) {
        uncertain = true;
        inFlight = false;
        return textResult(`无法可靠记录本地调用，没有执行：${errorText(e)}`, false);
      }
      activity(command);
      try {
        const shell =
          process.platform === "win32"
            ? [
                ...commandParts(options.resolve("powershell.exe")),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                command,
              ]
            : ["/bin/sh", "-c", command];
        const mode = request.seat.permissionMode ?? "workspace";
        const networkAccess = request.seat.webAccess === true;
        const sandboxPolicy =
          mode === "yolo"
            ? { type: "dangerFullAccess" }
            : mode === "read-only"
              ? { type: "readOnly", networkAccess }
              : { type: "workspaceWrite", writableRoots: [request.cwd], networkAccess };
        const reply = await runtime.request<ExecReply>(
          "command/exec",
          { command: shell, cwd: request.cwd, timeoutMs, sandboxPolicy },
          Number(timeoutMs) + 60000,
        );
        received += reply.stdout.length + reply.stderr.length;
        writeFileSync(
          lockFile,
          JSON.stringify({
            at: Date.now(),
            project: request.cwd,
            scope,
            callId: call.callId,
            digest,
            state: "completedAwaitingCloud",
            exitCode: reply.exitCode,
            stdout: reply.stdout.slice(-32000),
            stderr: reply.stderr.slice(-8000),
          }),
          { mode: 0o600 },
        );
        return textResult(
          JSON.stringify({
            location: "workstation",
            exitCode: reply.exitCode,
            stdout: reply.stdout.slice(-32000),
            stderr: reply.stderr.slice(-8000),
            truncated: reply.stdout.length > 32000 || reply.stderr.length > 8000,
          }),
          reply.exitCode === 0,
        );
      } catch (e) {
        if (/sandbox denied exec error, exit code: \d+, stdout:/.test(errorText(e))) {
          return textResult(`本地命令已结束但失败，未提升权限：${errorText(e)}`, false);
        }
        // No automatic rerun after an ambiguous transport/process failure.
        uncertain = true;
        return textResult(`本地工具未确认结算，停止后续操作并核对：${errorText(e)}`, false);
      } finally {
        inFlight = false;
        activity();
      }
    })();
    actions.set(call.callId, { digest, result });
    return result;
  }

  const result = (async (): Promise<SeatResult> => {
    const deadline = setTimeout(() => rejectTurn?.(new Error("云端运行超过 30 分钟上限；没有自动重试。")), 1800000);
    request.signal?.addEventListener("abort", stop, { once: true });
    try {
      if (request.signal?.aborted) {
        cancelled = true;
        throw new Error("已取消。");
      }
      if (!existsSync(connection.cloud?.identityFile ?? "") || !existsSync(connection.cloud?.knownHostsFile ?? ""))
        throw new Error("SSH 密钥或主机记录文件不存在；请编辑云端连接。");
      cloud = new CloudRpc(options.resolve("ssh"), cloudSshArgs(connection), request.cwd, sshEnvironment());
      const done = new Promise<void>((ok, bad) => {
        settleTurn = ok;
        rejectTurn = bad;
      });
      void done.catch(() => undefined);
      cloud.onClosed = (e) => rejectTurn?.(e);
      cloud.onMessage = (m: RpcMessage) => {
        if (m.id !== undefined && m.method !== undefined) {
          const id = m.id;
          if (m.method === "item/tool/call")
            void tool(m.params as unknown as ToolCall)
              .then((reply) => {
                if (!ended) cloud?.send({ id, result: reply });
              })
              .catch((e: unknown) => rejectTurn?.(new Error(errorText(e))));
          else
            cloud?.send({
              id: m.id,
              error: { code: -32601, message: "Cloud runtime has no local authorization authority" },
            });
          return;
        }
        const p = m.params;
        if (p === undefined || p["threadId"] !== threadId) return;
        if (m.method === "item/started" || m.method === "item/completed") {
          const itemType = (p["item"] as { type?: string } | undefined)?.type;
          if (itemType !== undefined && CLOUD_NATIVE_TOOL_ITEMS.has(itemType)) {
            if (inFlight) uncertain = true;
            cloudPolicyFailure ??= new Error(
              `云端报告了原生工具操作（${itemType}），本轮已停止。工作站任务必须交给 Squad 的本机 Harness。`,
            );
            rejectTurn?.(cloudPolicyFailure);
            return;
          }
        }
        if (cloudPolicyFailure !== undefined) return;
        if (m.method === "item/agentMessage/delta" && typeof p["delta"] === "string") {
          text += p["delta"];
          received += p["delta"].length;
          if (text.length > 1024 * 1024) {
            rejectTurn?.(new Error("云端回复超过 1 MiB 上限。"));
            return;
          }
          activity();
        }
        if (m.method === "turn/started") turnId = (p["turn"] as { id: string }).id;
        if (m.method === "thread/tokenUsage/updated") {
          const reported = p["tokenUsage"] as { total?: typeof counters; last?: { inputTokens: number } };
          const total = reported?.total;
          if (
            total !== undefined &&
            [total.inputTokens, total.outputTokens, total.cachedInputTokens].every(
              (n) => Number.isSafeInteger(n) && n >= 0,
            )
          ) {
            counters = total;
            const cached = Math.max(0, total.cachedInputTokens - baseline.cachedInputTokens);
            usage = {
              inputTokens: Math.max(0, total.inputTokens - baseline.inputTokens - cached),
              outputTokens: Math.max(0, total.outputTokens - baseline.outputTokens),
              cacheReadTokens: cached,
              cacheCreationTokens: 0,
              ...(reported.last === undefined ? {} : { contextTokens: reported.last.inputTokens }),
            };
          }
        }
        if (m.method === "turn/completed") {
          const turn = p["turn"] as { status: string; error?: { message: string } };
          if (turn.status === "completed") settleTurn?.();
          else rejectTurn?.(new Error(turn.error?.message ?? `云端回合状态：${turn.status}`));
        }
      };
      await cloud.initialize();
      const params: Record<string, unknown> = {
        approvalPolicy: "never",
        sandbox: "read-only",
        config: CLOUD_REASONING_CONFIG,
        ...(resumed === undefined ? { environments: [], dynamicTools: [SHELL_TOOL, IMAGE_TOOL, COMPUTER_TOOL] } : {}),
        developerInstructions: [
          "You are the reasoning agent for a Squad seat. Squad's local Harness executes workstation actions for you.",
          "For any task requiring a tool, call the appropriate workstation_* function, wait for its result, and continue this same turn from that result.",
          "Do not use the cloud runtime's shell, filesystem, MCP, search, or subagents. Do not install tools on the cloud host or ask the user to perform an action the local Harness can do.",
          `The local workstation is ${process.platform}; its project is ${request.cwd}. Use workstation_shell for local commands and files and workstation_image to inspect local project images.`,
          "Use workstation_computer for desktop and browser UI; do not use shell or browser debugging for UI. List windows, then observe before each action. Do not automate terminal, authentication or security windows.",
          "Respect refusals from the local Harness, never retry unknown effects, and report missing local capabilities without switching to cloud tools.",
        ].join("\n"),
        ...(connection.modelId === undefined || connection.modelId === "" ? {} : { model: connection.modelId }),
      };
      let opened: ThreadReply;
      try {
        opened = await cloud.request<ThreadReply>(resumed === undefined ? "thread/start" : "thread/resume", {
          ...params,
          ...(resumed === undefined ? {} : { threadId: resumed }),
        });
      } catch (e) {
        if (resumed !== undefined && /not found|no rollout/i.test(errorText(e)))
          return {
            text: "云端会话不存在，正在重建上下文。",
            failed: true,
            cancelled: false,
            resetSession: true,
            exitCode: null,
            durationMs: Date.now() - started,
          };
        throw e;
      }
      if (opened.approvalPolicy !== "never")
        throw new Error("云端运行时未确认仅推理模式；已停止发送任务。请更新云端设备网关或 Codex App Server。");
      threadId = opened.thread.id;
      await cloud.request("turn/start", {
        threadId,
        environments: [],
        input: [{ type: "text", text: request.prompt }],
        ...(request.seat.reasoningEffort === undefined ? {} : { effort: request.seat.reasoningEffort }),
      });
      await done;
      if (cloudPolicyFailure !== undefined) throw cloudPolicyFailure;
      if (uncertain) throw new Error("本地操作仍需核对，不把云端回答当作成功。");
      return {
        text,
        failed: false,
        cancelled: false,
        usage,
        sessionId: Buffer.from(JSON.stringify({ scope, thread: threadId, counters })).toString("base64url"),
        exitCode: 0,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
      return {
        text: `${text}${text === "" ? "" : "\n\n"}⚠️ ${errorText(e)}${lockHeld ? `\n请核对本地工具记录：${lockFile}` : ""}`,
        failed: true,
        cancelled,
        exitCode: null,
        durationMs: Date.now() - started,
        usage,
      };
    } finally {
      ended = true;
      clearTimeout(deadline);
      request.signal?.removeEventListener("abort", stop);
      await Promise.all([cloud?.close(), local?.close(), computer?.close()]);
      if (lockHeld && !uncertain && failure === undefined && !cancelled) {
        try {
          rmSync(lockFile, { force: true });
        } catch {
          /* Leave the guard in place if cleanup fails. */
        }
      }
      if (lockHeld) options.active?.delete(lockFile);
      if (localHome !== undefined && !uncertain) {
        try {
          await rm(localHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
          /* Windows may still be releasing the stopped process files. */
        }
      }
    }
  })();
  return { result, cancel: stop };
}

function commandParts(command: ResolvedCommand): string[] {
  return [command.file, ...command.prefixArgs];
}
function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/Bearer\s+\S+|\bsk-[\w-]+/gi, "[已隐藏]").slice(0, 1600);
}
