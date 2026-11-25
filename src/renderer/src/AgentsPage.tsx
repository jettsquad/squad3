/**
 * AgentsPage.tsx — the Agent library: the form on the left, the list on the right.
 *
 * 移植自 Squad 2.x packages/console/src/client/agents.tsx @ 8dcb903
 * 改动：文案直接写中文（多语言在阶段 3c）；声音一栏在阶段 5（朗读）回来，组件在 Voice.tsx；
 * An Agent pairs an existing inference connection with a local Harness.
 */
import { useState, type JSX } from "react";
import {
  connectionCompatibility,
  inferenceProtocol,
  defaultEffortOf,
  defaultPermissionMode,
  meaningfulCaps,
  overallOf,
  permissionModesFor,
  reasoningEffortsFor,
  type AgentBackend,
  type AuthMode,
  type PermissionMode,
  type ReasoningEffort,
  type SeatCaps,
} from "../../shared/index.ts";
import type { AgentWire, MethodOutput } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { BACKEND_LABELS, libraryChanged, numberOrUndefined, useLibrary } from "./library.ts";
import { t } from "./locale.ts";
import { VoicePicker } from "./Voice.tsx";
import { BackendTools } from "./BackendTools.tsx";

/**
 * The colours a seat can wear. Ten, because six ran out — a team of seven had
 * two members sharing a colour, which says the wrong thing rather than nothing.
 */
export const COLORS = [
  "#2e7d6b",
  "#3b6ea5",
  "#8a5cb8",
  "#b8783c",
  "#a8455a",
  "#4a7c3f",
  "#2f8fa8",
  "#9c6b2f",
  "#6a5acd",
  "#b05a8f",
];

type Report = MethodOutput<"agents.check">;

interface Draft {
  templateId: string;
  displayName: string;
  role: string;
  systemPrompt: string;
  backend: AgentBackend;
  permissionMode: PermissionMode;
  reasoningEffort: ReasoningEffort | "";
  secretaryCandidate: boolean;
  webAccess: boolean;
  computerAccess: boolean;
  hostCustomizations: boolean;
  subagents: boolean;
  color: string;
  /** "" means: assigned from the name. */
  voiceId: string;
  /** "" means the host's own login. */
  connectionId: string;
  maxTurns: string;
  maxTokens: string;
  maxCostUsd: string;
}

const blank = (): Draft => ({
  templateId: `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  displayName: "",
  role: "",
  systemPrompt: "",
  backend: "claude-code",
  permissionMode: defaultPermissionMode("claude-code"),
  reasoningEffort: "",
  secretaryCandidate: false,
  webAccess: false,
  computerAccess: false,
  hostCustomizations: false,
  subagents: false,
  color: COLORS[0] ?? "#2e7d6b",
  voiceId: "",
  connectionId: "",
  maxTurns: "",
  maxTokens: "",
  maxCostUsd: "",
});

function draftOf(agent: AgentWire): Draft {
  return {
    ...blank(),
    templateId: agent.templateId,
    displayName: agent.displayName,
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    backend: agent.backend,
    permissionMode: agent.permissionMode ?? defaultPermissionMode(agent.backend),
    reasoningEffort: agent.reasoningEffort ?? "",
    secretaryCandidate: agent.secretaryCandidate,
    webAccess: agent.webAccess === true,
    computerAccess: agent.computerAccess === true,
    hostCustomizations: agent.hostCustomizations === true,
    subagents: agent.subagents === true,
    color: agent.color,
    voiceId: agent.voiceId ?? "",
    connectionId: agent.connectionId ?? "",
    maxTurns: agent.caps?.maxTurns === undefined ? "" : String(agent.caps.maxTurns),
    maxTokens: agent.caps?.maxTokens === undefined ? "" : String(agent.caps.maxTokens),
    maxCostUsd: agent.caps?.maxCostUsd === undefined ? "" : String(agent.caps.maxCostUsd),
  };
}

/** Only the caps that can bind under this mode; the rest are not sent at all. */
export function capsOf(
  raw: { maxTurns: string; maxTokens: string; maxCostUsd: string },
  mode: AuthMode,
): SeatCaps | undefined {
  const allowed = new Set(meaningfulCaps(mode));
  const caps: { maxTurns?: number; maxTokens?: number; maxCostUsd?: number } = {};
  const turns = numberOrUndefined(raw.maxTurns);
  const tokens = numberOrUndefined(raw.maxTokens);
  const cost = numberOrUndefined(raw.maxCostUsd);
  if (allowed.has("maxTurns") && turns !== undefined) caps.maxTurns = Math.round(turns);
  if (allowed.has("maxTokens") && tokens !== undefined) caps.maxTokens = Math.round(tokens);
  if (allowed.has("maxCostUsd") && cost !== undefined) caps.maxCostUsd = cost;
  return Object.keys(caps).length === 0 ? undefined : caps;
}

/** What 「默认」 actually means for this backend and model, said in the option itself. */
function defaultEffortLabel(target: Parameters<typeof defaultEffortOf>[0]): string {
  const fallback = defaultEffortOf(target);
  return fallback.kind === "sends"
    ? t("思考强度：默认（实际会用 {effort}）", { effort: fallback.level })
    : fallback.kind === "config"
      ? t("思考强度：默认（用本机 CLI 配置）")
      : t("思考强度：默认（不传，由服务端决定）");
}

const WEB_NOTE: Readonly<Record<string, string>> = {
  dsh: "联网：只能用 bash + curl（这条会自动写进它的提示词）。它没有 WebFetch，web_search 认的是 DeepSeek 的 key。",
  "codex-on":
    "联网：web_search 搜 + bash/curl 取（这条会自动写进它的提示词）。勾上这项 Squad 才会打开 codex 沙箱的出网通道，不勾则明确关掉。",
  "claude-code-on": "联网：用 WebFetch / WebSearch，仅 HTTPS（这条会自动写进它的提示词）。bash + curl 仍会被权限拦下。",
  off: "联网：不行。勾上下面这项才行。",
};

export function AgentsPage(): JSX.Element {
  const { library, error: loadError } = useLibrary();
  const [draft, setDraft] = useState<Draft>(blank);
  /**
   * Per-agent test reports. `"running"` is its own state, not a spinner over
   * a stale report — a person who clicks 测试 on an agent they just edited
   * must not read the previous run's green ticks as this one's.
   */
  const [reports, setReports] = useState<Record<string, Report | "running">>({});
  const [query, setQuery] = useState("");
  const [refused, setRefused] = useState<readonly string[]>([]);
  const action = useAction();
  const set = (patch: Partial<Draft>): void => setDraft((current) => ({ ...current, ...patch }));

  const agents = library?.agents ?? [];
  const connections = library?.connections ?? [];
  const selectedConnection = connections.find((c) => c.connectionId === draft.connectionId);
  const cloudReasoning = draft.backend === "codex" && selectedConnection?.source === "octopus";
  const pairingProblem =
    selectedConnection === undefined
      ? draft.connectionId === ""
        ? undefined
        : t("⚠️ 连接已删除")
      : connectionCompatibility(draft.backend, selectedConnection);
  const lower = query.trim().toLowerCase();
  // Searched over the prompt too: 「哪个 agent 里写了红队」 is a real way to look for one.
  const shown = agents.filter(
    (agent) =>
      lower === "" ||
      [agent.displayName, agent.role, agent.backend, agent.systemPrompt].some((text) =>
        text.toLowerCase().includes(lower),
      ),
  );

  // The auth mode the caps must obey: the chosen connection's, the one being
  // configured here, or the host login's subscription.
  const mode: AuthMode = selectedConnection?.authMode ?? "subscription";
  const model = selectedConnection?.modelId;
  const protocol = selectedConnection === undefined ? undefined : inferenceProtocol(selectedConnection);
  const effortTarget = {
    backend: draft.backend,
    model,
    dshNative: protocol === undefined ? undefined : protocol === "deepseek-native",
  };

  const save = async (): Promise<void> => {
    setRefused([]);
    const done = await action.run(async () => {
      const caps = capsOf(draft, mode);
      const connectionId = draft.connectionId;
      const existing = agents.find((agent) => agent.templateId === draft.templateId);
      return call("agents.save", {
        agent: {
          templateId: draft.templateId,
          displayName: draft.displayName.trim(),
          role: draft.role.trim(),
          systemPrompt: draft.systemPrompt.trim(),
          backend: draft.backend,
          secretaryCandidate: draft.secretaryCandidate,
          webAccess: draft.webAccess,
          computerAccess: draft.computerAccess,
          hostCustomizations: draft.hostCustomizations,
          subagents: draft.subagents,
          color: draft.color,
          ...(draft.voiceId.trim() === "" ? {} : { voiceId: draft.voiceId.trim() }),
          enabled: true,
          ...(existing?.order === undefined ? {} : { order: existing.order }),
          ...(connectionId === "" ? {} : { connectionId }),
          ...(draft.backend === "dsh" ? {} : { permissionMode: draft.permissionMode }),
          ...(draft.reasoningEffort === "" ? {} : { reasoningEffort: draft.reasoningEffort }),
          ...(caps === undefined ? {} : { caps }),
        },
      });
    });
    libraryChanged();
    if (done === undefined) return;
    // The agent WAS saved; a team mid-round keeps its old copy until the next save.
    setRefused(done.refused);
    setDraft(blank());
  };

  const test = (agent: AgentWire): void => {
    setReports((current) => ({ ...current, [agent.templateId]: "running" }));
    void call("agents.check", { templateId: agent.templateId })
      .then((report) => setReports((current) => ({ ...current, [agent.templateId]: report })))
      .catch((failure: unknown) =>
        setReports((current) => ({
          ...current,
          [agent.templateId]: {
            templateId: agent.templateId,
            displayName: agent.displayName,
            checks: [
              {
                name: t("测试"),
                outcome: "fail",
                detail: failure instanceof Error ? failure.message : String(failure),
              },
            ],
          },
        })),
      );
  };

  const remove = async (agent: AgentWire): Promise<void> => {
    if (!window.confirm(t("删除「{name}」？已经用它建的团队不受影响，但库里就没有了。", { name: agent.displayName })))
      return;
    await action.run(() => call("agents.remove", { templateId: agent.templateId }));
    libraryChanged();
  };

  const move = async (agent: AgentWire, delta: number): Promise<void> => {
    await action.run(() => call("agents.move", { templateId: agent.templateId, delta }));
    libraryChanged();
  };

  const editingExisting = agents.some((agent) => agent.templateId === draft.templateId);

  return (
    <main className="main scroll">
      <div className="two-column">
        <div className="page">
          <h2>{editingExisting ? t("编辑 Agent") : t("新建 Agent")}</h2>
          {loadError !== undefined && <div className="error">{loadError}</div>}
          <div className="seat-row">
            <input
              value={draft.displayName}
              placeholder={t("Agent 名字，如 架构")}
              onChange={(event) => set({ displayName: event.target.value })}
            />
            <input
              value={draft.role}
              placeholder={t("角色，如 系统设计")}
              onChange={(event) => set({ role: event.target.value })}
            />
          </div>
          <textarea
            rows={4}
            value={draft.systemPrompt}
            placeholder={t("提示词——这个 agent 每一轮唯一读到的常驻说明")}
            onChange={(event) => set({ systemPrompt: event.target.value })}
          />

          <div className="section-title">{t("本机 Harness")}</div>
          <div className="seat-row" style={{ marginTop: 8 }}>
            <select
              aria-label={t("本机 Harness")}
              value={draft.backend}
              onChange={(event) => {
                const backend = event.target.value as AgentBackend;
                set({
                  backend,
                  permissionMode: defaultPermissionMode(backend),
                  reasoningEffort: "",
                });
              }}
            >
              {(["claude-code", "codex", "dsh"] as const).map((backend) => (
                <option key={backend} value={backend}>
                  {BACKEND_LABELS[backend]}
                </option>
              ))}
            </select>
            {draft.backend === "dsh" ? null : (
              <select
                value={draft.permissionMode}
                onChange={(event) => set({ permissionMode: event.target.value as PermissionMode })}
              >
                {permissionModesFor(draft.backend).map((permissionMode) => (
                  <option key={permissionMode} value={permissionMode}>
                    {t("权限：{mode}", { mode: permissionMode })}
                  </option>
                ))}
              </select>
            )}
            <select
              value={draft.reasoningEffort}
              onChange={(event) => set({ reasoningEffort: event.target.value as ReasoningEffort | "" })}
            >
              <option value="">{defaultEffortLabel(effortTarget)}</option>
              {reasoningEffortsFor(effortTarget).map((effort) => (
                <option key={effort} value={effort}>
                  {t("思考强度：{effort}", { effort })}
                </option>
              ))}
            </select>
          </div>
          {draft.backend === "claude-code" && draft.permissionMode === "acceptEdits" && (
            <p className="muted">
              {t("acceptEdits 只自动批准改文件；跑命令（测试、构建）会被拦下，因为席位没有人可以点「允许」。")}
            </p>
          )}

          <div className="section-title">{t("推理连接")}</div>
          <select
            aria-label={t("推理连接")}
            value={draft.connectionId}
            onChange={(event) => set({ connectionId: event.target.value, reasoningEffort: "" })}
          >
            <option value="">{t("使用所选 Harness 的本机登录")}</option>
            {connections.map((connection) => (
              <option key={connection.connectionId} value={connection.connectionId}>
                {connection.displayName}
                {connection.modelId === undefined ? "" : ` · ${connection.modelId}`}
                {connection.source === "octopus" ? " · Octopus" : ""}
              </option>
            ))}
            {selectedConnection === undefined && draft.connectionId !== "" && (
              <option value={draft.connectionId}>{t("⚠️ 连接已删除")}</option>
            )}
          </select>
          <p className="muted">{t("在连接库添加或修改 API 与云端 Agent 来源。")}</p>
          {pairingProblem !== undefined && <p className="notice inline">{pairingProblem}</p>}

          <div className="section-title">{t("上限")}</div>
          <div className="seat-row">
            <input
              value={draft.maxTurns}
              placeholder={t("轮数上限")}
              onChange={(event) => set({ maxTurns: event.target.value })}
            />
            <input
              value={draft.maxTokens}
              placeholder={t("token 上限")}
              onChange={(event) => set({ maxTokens: event.target.value })}
            />
            {/* Absent, not disabled: a greyed-out box still reads as "a thing
                this agent has", and a subscription ceiling could never fire. */}
            {!meaningfulCaps(mode).includes("maxCostUsd") ? null : (
              <input
                value={draft.maxCostUsd}
                placeholder={t("花费上限 $")}
                onChange={(event) => set({ maxCostUsd: event.target.value })}
              />
            )}
          </div>
          {meaningfulCaps(mode).includes("maxCostUsd") ? null : (
            <p className="muted">{t("订阅模式不计费，所以没有花费上限。")}</p>
          )}

          <div className="section-title">{t("能力")}</div>
          <label className="check block">
            <input
              type="checkbox"
              checked={draft.secretaryCandidate}
              onChange={(event) => set({ secretaryCandidate: event.target.checked })}
            />
            {t("可以当秘书")}
          </label>
          <p className="muted">
            {draft.backend === "dsh"
              ? t(WEB_NOTE["dsh"] ?? "")
              : draft.webAccess
                ? t(WEB_NOTE[`${draft.backend}-on`] ?? "")
                : t(WEB_NOTE["off"] ?? "")}
          </p>
          {/* Not dsh: it reaches the web through bash whatever this says, so a
              switch there would change nothing. */}
          {draft.backend === "dsh" ? null : (
            <label className="check block">
              <input
                type="checkbox"
                checked={draft.webAccess}
                onChange={(event) => set({ webAccess: event.target.checked })}
              />
              {draft.backend === "codex"
                ? t("允许联网（打开 codex 沙箱的出网通道）")
                : t("允许联网（预先批准 WebFetch / WebSearch）")}
            </label>
          )}
          {draft.backend !== "codex" ? null : (
            <>
              <label className="check block">
                <input
                  type="checkbox"
                  checked={draft.computerAccess}
                  onChange={(event) => set({ computerAccess: event.target.checked })}
                />
                {t("预先授权云端席位使用本机 Computer Use")}
              </label>
              <p className="muted">
                {t(
                  "开启后，该云端席位可在任务中查看和操作本机应用，不再逐次询问；需同时选择完全访问权限。保存后会同步到使用此 Agent 的团队。关闭后仍会逐次询问。",
                )}
              </p>
            </>
          )}
          {draft.backend !== "claude-code" ? null : (
            <>
              <label className="check block">
                <input
                  type="checkbox"
                  checked={draft.hostCustomizations}
                  onChange={(event) => set({ hostCustomizations: event.target.checked })}
                />
                {t("读取本机 Claude 配置（~/.claude）")}
              </label>
              <p className="muted">
                {draft.hostCustomizations
                  ? t(
                      "这个席位每次新开会话，会先把 ~/.claude 下的全部内容读进去——常驻前缀会大很多，按最贵的「建缓存」计价。只在这个席位真的要干 Claude Code 本行时才勾。",
                    )
                  : t("本机配置不读。项目自己的 CLAUDE.md 不受影响，Squad 会替它读。")}
              </p>
            </>
          )}
          {cloudReasoning ? (
            <p className="muted">{t("Octopus 负责推理，工具由本机 Codex Harness 执行。此连接不启用云端子 Agent。")}</p>
          ) : (
            <>
              <label className="check block">
                <input
                  type="checkbox"
                  checked={draft.subagents}
                  onChange={(event) => set({ subagents: event.target.checked })}
                />
                {t("允许派生子 agent")}
              </label>
              <p className="muted">
                {draft.subagents
                  ? t(
                      "这个 agent 可以把活拆给它自己的子 agent 并行做。子 agent 的过程不进讨论记录，只有它的最终回答进；花费都记在它头上。不适合秘书。",
                    )
                  : t("不能派生子 agent——三种后端都关掉了这个能力。")}
              </p>
            </>
          )}

          <div className="section-title">{t("颜色")}</div>
          <div className="row-gap">
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={t("颜色 {color}", { color })}
                className={`swatch ${draft.color === color ? "on" : ""}`}
                style={{ background: color }}
                onClick={() => set({ color })}
              />
            ))}
          </div>

          <div className="section-title">{t("声音")}</div>
          <VoicePicker value={draft.voiceId} name={draft.displayName} onChange={(voiceId) => set({ voiceId })} />

          {action.error !== undefined && <div className="error">{action.error}</div>}
          {refused.length > 0 && (
            <div className="notice inline">
              {t("这些团队正在跑，这次没能同步过去（下次保存会再试）：{teams}", { teams: refused.join("；") })}
            </div>
          )}
          <div className="row-gap">
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={action.busy || pairingProblem !== undefined}
            >
              {t("保存 Agent")}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(blank());
              }}
            >
              {t("清空")}
            </button>
          </div>
        </div>

        <div className="page">
          {/* Above the list: when a seat fails for a reason that is not the seat's, an old CLI is the usual one. */}
          <BackendTools />
          <h2>{t("已有 Agent（{n}）", { n: lower === "" ? agents.length : `${shown.length} / ${agents.length}` })}</h2>
          <input
            value={query}
            placeholder={t("搜名字、角色、后端、提示词……")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {library !== undefined && agents.length === 0 && (
            <p className="muted">{t("还没有。左边配一个，之后每支团队都能直接选它。")}</p>
          )}
          {agents.length > 0 && shown.length === 0 && (
            <p className="muted">{t("没有匹配「{query}」的 agent。", { query })}</p>
          )}
          {shown.map((agent) => {
            const index = agents.indexOf(agent);
            const connection = connections.find((c) => c.connectionId === agent.connectionId);
            const report = reports[agent.templateId];
            return (
              <div className="card" key={agent.templateId}>
                <div className="row-gap" style={{ margin: 0 }}>
                  <span className="dot" style={{ background: agent.color }} />
                  <strong>{agent.displayName}</strong>
                  <span className="muted">{agent.role}</span>
                  {agent.secretaryCandidate && <span className="muted">{t("★ 可当秘书")}</span>}
                  <span style={{ flex: 1 }} />
                  {/* Hidden while filtering: next to a filtered view the arrows
                      would swap with a neighbour that is not on screen. */}
                  {lower === "" && (
                    <>
                      <button
                        type="button"
                        className="link"
                        disabled={index === 0}
                        onClick={() => void move(agent, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="link"
                        disabled={index === agents.length - 1}
                        onClick={() => void move(agent, 1)}
                      >
                        ↓
                      </button>
                    </>
                  )}
                </div>
                <div className="muted">
                  {BACKEND_LABELS[agent.backend] ?? agent.backend}
                  {agent.permissionMode === undefined ? "" : ` · ${agent.permissionMode}`}
                  {agent.reasoningEffort === undefined
                    ? ""
                    : ` · ${t("思考 {effort}", { effort: agent.reasoningEffort })}`}
                  {" · "}
                  {agent.connectionId === undefined ? t("本机登录") : (connection?.displayName ?? t("⚠️ 连接已删除"))}
                </div>
                {report === "running" && <div className="muted">{t("测试中……会真的问它一句，最多等 90 秒。")}</div>}
                {report !== undefined && report !== "running" && <CheckReport report={report} />}
                <div className="row-gap">
                  <button type="button" onClick={() => setDraft(draftOf(agent))}>
                    {t("编辑")}
                  </button>
                  <button type="button" onClick={() => test(agent)} disabled={report === "running"}>
                    {t("测试")}
                  </button>
                  <button type="button" onClick={() => void remove(agent)}>
                    {t("删除")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}

function CheckReport({ report }: { readonly report: Report }): JSX.Element {
  const overall = overallOf(report);
  return (
    <div className="report">
      <div className={overall === "fail" ? "bad" : overall === "ok" ? "good" : "muted"}>
        {overall === "ok" ? t("✅ 能用") : overall === "fail" ? t("❌ 有问题") : t("⚠️ 有检查没能跑，结论不完整")}
      </div>
      {report.checks.map((check) => (
        <div key={check.name} className={check.outcome === "fail" ? "bad" : "muted"}>
          {/* 「—」是不适用，「❓」是想查没查成：前者是答案，后者是缺口。 */}
          {check.outcome === "ok"
            ? "✅"
            : check.outcome === "fail"
              ? "❌"
              : check.outcome === "unknown"
                ? "❓"
                : "—"}{" "}
          {check.name}：{check.detail}
        </div>
      ))}
    </div>
  );
}
