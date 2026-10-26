/**
 * agent-check — 「测试」 on an agent in the library: five answers, not one verdict.
 *
 * 移植自 Squad 2.x packages/console/src/http.ts 的 checkAgent / probeSeat @ 8dcb903
 * （含 2.x 工作区尚未提交的 reconcileReachability）。
 * 改动：
 * - ① 不再问「dsh 里注册没注册这个 provider」，问「有没有这个后端的适配器、连接还在不在、
 *   后端对不对得上」——3 里席位就是这么被派发的。
 * - ② 找命令行工具走适配器自己的 `locate`，和开跑时一模一样（dsh 读设置里的路径）。
 * - ⑤ 探针不再借 dsh 的宿主节点，而是在一个用完即删的临时文件夹里直接起一轮席位。
 *
 * They fail for unrelated reasons and each has a different fix: the CLI is
 * not installed, the connection is gone, the key is missing, the endpoint is
 * unreachable, the endpoint is reachable and speaks another protocol. A
 * single 「测试失败」 sends a person looking in the wrong place.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionMismatch,
  reconcileReachability,
  type AgentCheckReport,
  type AgentTemplate,
  type CheckResult,
  type SeatSpec,
} from "../../shared/index.ts";
import type { Library } from "../library/index.ts";
import type { ResolvedConnection, Seats } from "../seats/index.ts";

/** How long a probe may take before it is a failure in its own right. */
export const PROBE_TIMEOUT_MS = 90_000;

const PROBE_PROMPT = "回答两个字：收到。不要做别的事，不要读写任何文件。";

export interface AgentCheckDeps {
  readonly seats: Seats;
  readonly library: Pick<Library, "agents" | "connections">;
  /** For the reachability check; injected so tests need no network. */
  readonly fetch?: typeof fetch;
  readonly probeTimeoutMs?: number;
}

export type AgentCheck = (templateId: string) => Promise<AgentCheckReport>;

export function createAgentCheck(deps: AgentCheckDeps): AgentCheck {
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const head = deps.fetch ?? fetch;

  /**
   * Run one real, tiny turn through this agent's actual backend.
   *
   * It costs a model call. That is the price of an answer to "does this
   * work", and the alternative — four green ticks over a configuration that
   * cannot answer anything — already cost more. In a throwaway folder: a
   * seat started in a team's folder could touch that project.
   */
  const probe = async (template: AgentTemplate, connection: ResolvedConnection | undefined): Promise<CheckResult> => {
    const name = "真的问一句";
    const adapter = deps.seats.adapterFor(template.backend);
    if (typeof adapter === "string") return { name, outcome: "unknown", detail: adapter };
    const cwd = await mkdtemp(join(tmpdir(), "squad-probe-"));
    const deadline = AbortSignal.timeout(probeTimeoutMs);
    try {
      const seat: SeatSpec = {
        seatId: "probe",
        displayName: `${template.displayName}（测试）`,
        role: template.role,
        systemPrompt: template.systemPrompt,
        backend: template.backend,
        connectionId: template.connectionId,
        permissionMode: template.permissionMode,
        // The chosen level goes into the probe too: a gateway that refuses it
        // should fail HERE, at 测试, not in the first round.
        reasoningEffort: template.reasoningEffort,
        webAccess: template.webAccess,
        hostCustomizations: template.hostCustomizations,
      };
      const result = await adapter.start({
        seat,
        ...(connection === undefined ? {} : { connection }),
        cwd,
        prompt: PROBE_PROMPT,
        signal: deadline,
      }).result;
      const text = result.text.trim();
      if (result.failed || result.cancelled) {
        // Our own deadline is named, because 「被取消」 says nothing: it reads
        // as a cancellation somebody asked for. A CLI that handshakes and
        // then never answers is the shape a wrong-protocol endpoint has.
        const detail = deadline.aborted
          ? `${Math.round(probeTimeoutMs / 1000)} 秒内没有答复。多半是这个端点不讲 ${template.backend} 的协议——` +
            `它能连上不代表它听得懂。`
          : text !== ""
            ? text
            : `退出码 ${String(result.exitCode)}，而且什么都没输出。`;
        return { name, outcome: "fail", detail };
      }
      if (text === "") return { name, outcome: "fail", detail: "跑完了，但一个字都没答。" };
      return { name, outcome: "ok", detail: `答了：${text.slice(0, 120)}${text.length > 120 ? "…" : ""}` };
    } catch (failure) {
      return { name, outcome: "fail", detail: failure instanceof Error ? failure.message : String(failure) };
    } finally {
      // Removed on every path: a probe that leaked its folder would leave one
      // in the temp directory for every click of a test button.
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  return async (templateId) => {
    const template = deps.library.agents.get(templateId);
    if (template === undefined) throw new Error(`Agent 库里没有这个模板：${templateId}。`);
    const checks: CheckResult[] = [];
    const connectionId = (template.connectionId ?? "").trim();
    const connection = connectionId === "" ? undefined : deps.library.connections.get(connectionId);

    // ① The seat backend: an adapter for it, and a connection that exists and
    // belongs to it. Each of these otherwise fails at the FIRST ROUND.
    const adapter = deps.seats.adapterFor(template.backend);
    const mismatch =
      connection === undefined
        ? undefined
        : connectionMismatch(template.backend, connection.backend, connection.displayName);
    const backendProblem =
      typeof adapter === "string"
        ? adapter
        : connectionId !== "" && connection === undefined
          ? `它用的连接「${connectionId}」已经不在了。`
          : mismatch;
    checks.push(
      backendProblem === undefined
        ? {
            name: "席位后端",
            outcome: "ok",
            detail:
              connection === undefined
                ? `${template.backend}，本机登录`
                : `${template.backend}，${connection.displayName}`,
          }
        : { name: "席位后端", outcome: "fail", detail: backendProblem },
    );

    // ② The CLI itself, found exactly as a seat would find it.
    if (typeof adapter === "string" || adapter.locate === undefined) {
      // Wanted to check and could not — evidence is missing, so `unknown`.
      checks.push({ name: "命令行工具", outcome: "unknown", detail: `不知道 ${template.backend} 用哪个可执行文件。` });
    } else {
      try {
        const command = adapter.locate();
        checks.push({ name: "命令行工具", outcome: "ok", detail: [command.file, ...command.prefixArgs].join(" ") });
      } catch (failure) {
        checks.push({
          name: "命令行工具",
          outcome: "fail",
          detail: failure instanceof Error ? failure.message : String(failure),
        });
      }
    }

    // ③ The credential, when the connection needs one.
    if (connectionId === "") {
      checks.push({ name: "密钥", outcome: "skipped", detail: "用本机登录态，不需要密钥。" });
    } else if (connection === undefined) {
      checks.push({ name: "密钥", outcome: "fail", detail: `连接 ${connectionId} 不存在了。` });
    } else if (connection.authMode === "subscription") {
      checks.push({ name: "密钥", outcome: "skipped", detail: "订阅模式用本机登录态，不需要密钥。" });
    } else {
      const view = deps.library.connections.views().find((one) => one.connectionId === connection.connectionId);
      checks.push(
        view?.credentialConfigured === true
          ? { name: "密钥", outcome: "ok", detail: `已配置（${connection.credentialRef ?? ""}）` }
          : {
              name: "密钥",
              outcome: "fail",
              detail: `「${connection.credentialRef ?? ""}」还没有值。到「连接」里填上。`,
            },
      );
    }

    // ④ The endpoint — REACHABILITY ONLY, and labelled as such. Any status
    // proves a host is there; it proves nothing about the protocol it speaks.
    const endpoint = (connection?.endpoint ?? "").trim();
    const reachabilityIndex = checks.length;
    if (endpoint === "") {
      checks.push({ name: "地址可达", outcome: "skipped", detail: "用后端默认地址。" });
    } else {
      try {
        const response = await head(endpoint, { method: "HEAD", signal: AbortSignal.timeout(8000) });
        checks.push({
          name: "地址可达",
          outcome: "ok",
          detail: `${endpoint} 有响应（HTTP ${response.status}）。只说明主机在，不说明它讲这个后端的协议。`,
        });
      } catch (failure) {
        checks.push({
          name: "地址可达",
          outcome: "fail",
          detail: `连不上 ${endpoint}（${failure instanceof Error ? failure.message : String(failure)}）`,
        });
      }
    }

    // ⑤ Actually ask it something. The four checks above are PLUMBING; they
    // all passed in 2.x for agents that could not answer a single question.
    // Not run when the plumbing already failed — it would only reproduce the
    // error above — and then `unknown`, so the report cannot read as a pass.
    if (backendProblem !== undefined) {
      checks.push({ name: "真的问一句", outcome: "unknown", detail: "席位后端没就绪，问不出去——先解决上面那条。" });
    } else {
      let resolved: ResolvedConnection | undefined;
      try {
        resolved =
          connection === undefined ? undefined : { connection, env: deps.library.connections.envFor(connectionId) };
      } catch (failure) {
        checks.push({
          name: "真的问一句",
          outcome: "fail",
          detail: failure instanceof Error ? failure.message : String(failure),
        });
        return { templateId, displayName: template.displayName, checks };
      }
      const asked = await probe(template, resolved);
      const reachability = checks[reachabilityIndex];
      if (reachability !== undefined) checks[reachabilityIndex] = reconcileReachability(reachability, asked);
      checks.push(asked);
    }
    return { templateId, displayName: template.displayName, checks };
  };
}
