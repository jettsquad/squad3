import { createHash, randomUUID } from "node:crypto";
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
import { refusedRun, type ResolvedCommand, type SeatResult, type SeatRun } from "../../seat-runtime/index.ts";
import type { SeatAdapter, SeatRequest } from "../types.ts";
import { CloudRpc, type RpcMessage } from "./rpc.ts";

type CommandResolver = (name: string) => ResolvedCommand;
interface ThreadReply {
  readonly thread: { readonly id: string };
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

/** Stable scope: changing a connection/profile/account revision cannot resume its old thread. */
export function cloudScope(connection: SeatConnection, cwd: string, seatId: string, scene?: string): string {
  return createHash("sha256")
    .update(JSON.stringify([connection.connectionId, connection.cloud, connection.modelId, cwd, seatId, scene]))
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
export function cloudSshArgs(connection: SeatConnection): readonly string[] {
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
    "-o",
    `UserKnownHostsFile=${c.knownHostsFile}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    `${c.user}@${c.host}`,
    `exec runuser -u ${c.runAs} -- timeout 1800 ${c.executable} app-server --stdio`,
  ];
}

function textResult(text: string, success: boolean): ToolReply {
  return { success, contentItems: [{ type: "inputText", text }] };
}

/** JSON does not leave this module except as the vendor's documented app-server protocol. */
export function createCloudAdapter(options: {
  readonly stateDir: string;
  readonly resolve: CommandResolver;
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
      if (request.seat.subagents === true || request.seat.hostCustomizations === true)
        return refusedRun("云端来源暂不支持本机自定义工具或子 agent；请在席位设置中关闭后使用。");
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
  options: { readonly stateDir: string; readonly resolve: CommandResolver },
): SeatRun {
  const started = Date.now();
  let cloud: CloudRpc | undefined;
  let local: CloudRpc | undefined;
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
    if (cancelled || ended || uncertain) return textResult("本地执行已停止或需要核对，不允许继续。", false);
    if (call.threadId !== threadId || call.turnId !== turnId) return textResult("工具调用不属于当前回合。", false);
    if (++toolCount > 40) return textResult("本轮超过 40 次工具调用上限。", false);
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
          writeFileSync(fd, JSON.stringify({ at: Date.now(), scope, callId: call.callId, digest, state: "pending" }));
        } finally {
          closeSync(fd);
        }
        lockHeld = true;
      }
      inFlight = true;
      // Update the retained guard for every action, not only the first one in a turn.
      try {
        writeFileSync(
          lockFile,
          JSON.stringify({ at: Date.now(), scope, callId: call.callId, digest, state: "pending" }),
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
      const transportEnv: NodeJS.ProcessEnv = { HOME: homedir() };
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
        if (process.env[key] !== undefined) transportEnv[key] = process.env[key];
      }
      cloud = new CloudRpc(options.resolve("ssh"), cloudSshArgs(connection), request.cwd, transportEnv);
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
        approvalPolicy: "on-request",
        sandbox: "read-only",
        environments: [],
        dynamicTools: [SHELL_TOOL, IMAGE_TOOL],
        developerInstructions: `You are a Squad 3 cloud seat. The workstation is ${process.platform}; its project is ${request.cwd}. Only workstation_shell performs business I/O. Do not access cloud business files or native tools. The host owns orchestration; do not contact other seats. Respect local refusals and never retry unknown effects.`,
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
      threadId = opened.thread.id;
      await cloud.request("turn/start", {
        threadId,
        input: [{ type: "text", text: request.prompt }],
        ...(request.seat.reasoningEffort === undefined ? {} : { effort: request.seat.reasoningEffort }),
      });
      await done;
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
      await Promise.all([cloud?.close(), local?.close()]);
      if (lockHeld && !uncertain && failure === undefined && !cancelled) {
        try {
          rmSync(lockFile, { force: true });
        } catch {
          /* Leave the guard in place if cleanup fails. */
        }
      }
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
