// 移植自 Squad 2.x packages/shared/src/agent-template.ts @ 8dcb903
/**
 * agent-template.ts — a reusable agent, configured once.
 *
 * Carried over from 1.x, where the Agent library was the thing that made a
 * second team cheap: you configure a 「架构」 once — its backend, its model, its
 * standing instructions, its ceilings — and every team after that picks it off
 * a list. 2.0 briefly did without one, and the cost showed up immediately in
 * the console: adding a seat could set a name and a role and nothing else, so
 * there was no way to say what model it ran on at the moment you were creating
 * it.
 *
 * What is NOT here is the model connection. A template REFERENCES one by id,
 * exactly as a seat does, because a gateway is shared by many agents and
 * copying its endpoint into each of them means rotating it touches every copy
 * — and the copy that was missed fails weeks later for a reason nobody
 * connects to the edit. That was already the argument for `SeatConnection`;
 * it does not become a different argument one layer up.
 */
import type { SeatCaps } from "./connection.ts";
import { reasoningEffortsOfBackend, type ReasoningEffort } from "./reasoning-effort.ts";

/** Which CLI runs this agent. Provider names are fixed by dsh. */
export type AgentBackend = "claude-code" | "codex" | "dsh";

/**
 * How much the CLI may do without asking.
 *
 * Two closed lists rather than one union of everything, because the two
 * backends do not have the same axes: Claude Code has a permission mode,
 * Codex has a sandbox level. A single flat list would let a person pick
 * `plan` for a Codex agent, which that CLI has never heard of, and the error
 * would arrive from the child process at the first round.
 */
export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;
export const CODEX_PERMISSION_MODES = ["read-only", "workspace", "yolo"] as const;
export type PermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number] | (typeof CODEX_PERMISSION_MODES)[number];

/** The permission modes this backend actually accepts. */
export function permissionModesFor(backend: AgentBackend): readonly PermissionMode[] {
  return backend === "codex" ? CODEX_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
}

/** What a backend gets when nobody chose. */
export function defaultPermissionMode(backend: AgentBackend): PermissionMode {
  return backend === "codex" ? "workspace" : "acceptEdits";
}

export interface AgentTemplate {
  readonly templateId: string;
  readonly displayName: string;
  readonly role: string;
  /** Standing instructions. Travels inside the prompt; see `SeatSpec`. */
  readonly systemPrompt: string;
  readonly backend: AgentBackend;
  /** Which connection supplies the model. Absent means the host's own login. */
  readonly connectionId?: string | undefined;
  readonly permissionMode?: PermissionMode | undefined;
  /**
   * How hard this agent's model thinks. Absent means the backend's own
   * default — see `defaultEffortOf` for what that actually is.
   */
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly caps?: SeatCaps | undefined;
  /** Whether this agent may be a team's secretary. */
  readonly secretaryCandidate: boolean;
  /** A tint, so a roster of six is readable at a glance. */
  readonly color: string;
  /**
   * Which voice reads this agent's replies aloud.
   *
   * On the agent rather than in the listener's browser, for the same reason
   * `color` is: it is how you tell this member from the others, and it should
   * not have to be set again on every machine. Absent falls back to a voice
   * derived from the display name — see `defaultVoiceFor` — so a roster is
   * followable by ear before anyone configures anything.
   */
  readonly voiceId?: string | undefined;
  /**
   * Let this agent reach the web without stopping to ask.
   *
   * Claude Code only, and that is a fact about the backends rather than a
   * gap. Measured on all three:
   *
   *   claude-code  `acceptEdits` auto-approves FILE EDITS and nothing else,
   *                so WebFetch and even `curl` come back
   *                「requires approval」 — and a seat runs `claude -p` with
   *                nobody there to approve, so the answer is always no.
   *   dsh          no permission gate at all; `bash` + `curl` reaches the
   *                web today. Its own `web_search` is mounted but resolves
   *                DEEPSEEK_API_KEY, so a seat on another provider's key
   *                gets 「Authentication Fails」; `fetch` is disabled in
   *                dsh-base on purpose (SSRF).
   *   codex        `workspace` already has a working web tool.
   *
   * So this flag changes the one backend that can be changed, by naming the
   * web tools as pre-approved. It is NOT `bypassPermissions`: everything
   * else still asks, and the delegation fence still holds.
   */
  readonly webAccess?: boolean | undefined;
  /**
   * Let this agent's `claude` read the HOST's own configuration.
   *
   * Claude Code only — it is the one backend whose CLI auto-loads a
   * configuration home. Off by default, and the default is the point: that
   * home currently holds 141,709 characters of framework, and the standing
   * prefix measured 100,113 tokens with it against 33,899 without. Every cold
   * start pays the difference in cache CREATION, the dearest tier.
   *
   * Close to half of what it loads describes capabilities a seat does not
   * have: slash commands it cannot call, thinking flags it cannot set,
   * sub-agent delegation when `Task` is denied to every seat. What a seat
   * SHOULD be given is prompt blocks — chosen per seat, visible on screen,
   * and readable by the codex and dsh seats too, which can never see a
   * `CLAUDE.md` at all.
   *
   * The project's own `CLAUDE.md` does not depend on this. Squad reads that
   * file itself and puts it in the prompt either way.
   *
   * Turn it on for a seat genuinely doing Claude Code's own job in a
   * repository, where the whole configuration is the point — knowing that it
   * buys the dead weight along with the useful part.
   */
  readonly hostCustomizations?: boolean | undefined;
  /**
   * Let this agent spawn subagents of its own.
   *
   * Off by default, on every backend. 1.x had no fence, and a secretary that
   * did not know the roster invented a team of its own to do the work —
   * bypassing the people at the table. All three backends can do it when
   * left alone (Claude Code's `Task`/`Agent`, Codex's `multi_agent` feature,
   * dsh's `subagent` tools), so the fence is spelled out for each.
   *
   * Turn it on for an agent that does hands-on work and benefits from fanning
   * it out — reading many files, researching in parallel. The subagents'
   * own steps do not enter the discussion; only this agent's answer does, and
   * their cost is counted as this agent's.
   */
  readonly subagents?: boolean | undefined;
  /**
   * Soft delete.
   *
   * A template a team was built from is not removed outright: the team holds
   * a copy of what it needed, but the library entry is what tells a person
   * where that seat came from. 1.x learned this — a hard delete left teams
   * referring to an agent that no screen could explain.
   */
  readonly enabled: boolean;
  /**
   * Position in the library, lowest first.
   *
   * Not a property of the agent — a property of the shelf it sits on. Kept on
   * the record anyway because there is nowhere else that survives a restart,
   * and a list whose order resets is a list nobody bothers to arrange.
   */
  readonly order?: number | undefined;
}

/**
 * Whether an agent may use this connection.
 *
 * The two backends must MATCH. They were free to disagree, and the failure
 * was silent and total: a connection registers its provider under its OWN
 * backend, so a `codex` agent pointing at a `claude-code` connection asks for
 * `codex/<id>` while `claude-code-fenced/<id>` is what exists. The round
 * fails naming a provider nobody typed — and the environment would have been
 * wrong regardless, since each backend reads different variables.
 */
export function connectionMismatch(
  agentBackend: string,
  connectionBackend: string,
  connectionName: string,
): string | undefined {
  if (agentBackend === connectionBackend) return undefined;
  return (
    `「${connectionName}」是 ${connectionBackend} 的连接，配不到 ${agentBackend} 的 agent 上。` +
    `每个后端读的环境变量不一样，provider 也是按连接自己的后端注册的——` +
    `请换一个 ${agentBackend} 的连接，或者把这个 agent 的后端改成 ${connectionBackend}。`
  );
}

export interface AgentTemplateProblem {
  readonly field: string;
  readonly detail: string;
}

/**
 * Check a template before it is saved.
 *
 * Field-tagged, so a form can put each complaint under the input that caused
 * it. A single joined sentence is what the console shipped first, and it read
 * as a wall of text next to three empty boxes.
 */
export function checkAgentTemplate(template: AgentTemplate): readonly AgentTemplateProblem[] {
  const problems: AgentTemplateProblem[] = [];
  if (template.displayName.trim() === "") problems.push({ field: "displayName", detail: "要有一个名字。" });
  if (template.role.trim() === "") problems.push({ field: "role", detail: "要写清楚这个 agent 的角色。" });
  if (template.systemPrompt.trim() === "") {
    problems.push({ field: "systemPrompt", detail: "要有提示词——它是这个 agent 每一轮唯一读到的常驻说明。" });
  }
  if (
    template.permissionMode !== undefined &&
    !permissionModesFor(template.backend).includes(template.permissionMode)
  ) {
    problems.push({
      field: "permissionMode",
      detail: `${template.backend} 没有「${template.permissionMode}」这个权限模式——它会被原样交给子进程，报错来自 CLI 而不是这里。`,
    });
  }
  if (
    template.reasoningEffort !== undefined &&
    !reasoningEffortsOfBackend(template.backend).includes(template.reasoningEffort)
  ) {
    problems.push({
      field: "reasoningEffort",
      detail: `${template.backend} 没有「${template.reasoningEffort}」这一档思考强度。`,
    });
  }
  return problems;
}

/**
 * The tools that reaching the web needs, pre-approved together.
 *
 * Both, because they are one capability to a person: search finds the page,
 * fetch reads it, and a seat that can only do half gives up halfway with an
 * explanation nobody asked for.
 */
export const WEB_TOOLS: readonly string[] = ["WebFetch", "WebSearch"];

/**
 * The download tool a claude-code seat with web access gets, and the MCP
 * server that provides it. `WebFetch` returns parsed text and often fails on
 * a PDF, so a datasheet had no route to disk. The tool is Squad's own
 * (`@squad/seat-runtime`): https only, no private addresses, a size cap, one
 * folder — where pre-approving `curl` would have allowed any write and any POST.
 */
export const DOWNLOAD_SERVER = "squad-download";
export const DOWNLOAD_TOOL_NAME = `mcp__${DOWNLOAD_SERVER}__download_file`;

/**
 * How this seat reaches the web, told to it up front.
 *
 * Each backend has exactly one route and they are all different, so a seat
 * left to discover its own burns rounds finding out — and sometimes never
 * does: a model that has been refused twice starts answering from memory and
 * says so afterwards, or not at all.
 *
 * Every line below was measured, on this machine, with a token the model
 * could not have guessed (a random string served over the wire, and a
 * `httpbin.org/base64/…` URL whose answer only a real fetch knows):
 *
 *   claude-code, web on   WebFetch returned the token. `bash`+`curl` came
 *                         back 「This command requires approval」. WebFetch
 *                         also upgrades `http://` to `https://` by itself —
 *                         a plain-HTTP address fails in the SSL handshake
 *                         before any response exists.
 *   claude-code, web off  Both refused for want of permission, every time.
 *   dsh                   `bash` + `curl` returned the token. No WebFetch at
 *                         all (dsh-base sets `fetch: false`), and its
 *                         `web_search` resolves DEEPSEEK_API_KEY, so a seat
 *                         on another provider's key gets 「Authentication
 *                         Fails」.
 *   codex, web off        Nothing works. `curl` cannot reach the sandbox's
 *                         proxy port and the web tool refuses the URL. Its
 *                         one apparent success was example.com, whose text
 *                         it knew by heart — the token test settled it.
 *   codex, web on         `bash` + `curl` returns the page, and `web_search`
 *                         answers. What changed is not the CLI but the argv:
 *                         Squad passes `network_access=true` and
 *                         `tools.web_search=true` when the seat is allowed
 *                         the web, and the same `curl` that failed to connect
 *                         at all comes back 200 (measured 2026-09-07,
 *                         codex-cli 0.153.4). Still no WebFetch — `codex
 *                         exec` has no such tool.
 *
 * Injected at TURN TIME rather than written into the agent's own standing
 * instructions. Both would tell the seat the same thing today; only this one
 * is still true after the backend is switched or 「允许联网」 is turned off,
 * and a standing instruction that has quietly gone wrong is worse than none.
 */
export function webAccessNote(backend: AgentBackend, webAccess: boolean): readonly string[] {
  if (backend === "dsh") {
    return [
      "## 你怎么上网",
      "你**只有一条**联网通路：`bash` + `curl`，例如 `curl -sSL --max-time 15 <url>`。",
      "你没有 WebFetch；`web_search` 虽然在工具表里，但它认的是 DEEPSEEK_API_KEY，" +
        "本席位用的不是那家的 key，调用只会返回「Authentication Fails」——不要浪费轮次去试。",
    ];
  }
  if (backend === "codex") {
    if (!webAccess) {
      return [
        "## 你不能上网",
        "这个席位没有开联网：沙箱没有出网通道，`curl` 连不上。",
        "需要网上的资料时，直接说你拿不到、并说明需要什么，让主持人来取。" +
          "**不要凭记忆把网页内容写出来当作抓取结果**——那比说拿不到更糟。" +
          "（主持人可以在 Agent 库里给你勾上「允许联网」。）",
      ];
    }
    return [
      "## 你怎么上网",
      "你有两条通路：`web_search` 工具用来搜，`bash` + `curl` 用来按 URL 取，" +
        "例如 `curl -sSL --max-time 15 <url>`。",
      "你没有 WebFetch——那是别的后端的工具，不要去找。",
      "拿不到的时候直接说拿不到，**不要凭记忆把网页内容写出来当作抓取结果**。",
    ];
  }
  if (!webAccess) {
    return [
      "## 你不能上网",
      "WebFetch 和 WebSearch 都会因为未授权被拒，`bash` + `curl` 同样会被权限拦下。",
      "需要网上的资料时，直接说你拿不到、并说明需要什么。" + "（主持人可以在 Agent 库里给你勾上「允许联网」。）",
    ];
  }
  return [
    "## 你怎么上网",
    "用 **WebFetch** 按 URL 抓页面，用 **WebSearch** 搜索——这两个已经预先批准，不会再问你要权限。",
    `要**下载文件**（PDF、datasheet、图片等二进制），WebFetch 做不到：用 \`${DOWNLOAD_TOOL_NAME}\` 工具（参数 url，可选 filename）。` +
      "它只接受 https 地址，文件存进团队文件夹的 `squad-downloads/`，返回绝对路径；之后用读文件工具打开。" +
      "图片可以在回复里写 `![说明](绝对路径)` 让主持人直接看到。",
    "注意 WebFetch 只走 HTTPS：它会把 `http://` 自动升级成 `https://`，所以明文 HTTP 地址会在 SSL 握手就失败。",
    "不要用 `bash` + `curl`：那条路没有被批准，会直接被拦下——下载请用上面的工具。",
  ];
}
