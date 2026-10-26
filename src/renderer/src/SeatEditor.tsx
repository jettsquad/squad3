/**
 * SeatEditor.tsx — one team's roster, what each seat runs on, and the team itself.
 *
 * 移植自 Squad 2.x packages/console/src/client/{seats,caps}.tsx @ 8dcb903 与
 * team-view.tsx 里的改名、解散（3 叫归档）、重新关联。
 * 改动：连接下拉只列这个席位后端的连接（2.x 列全部，选错了由服务端拒）——同 Agent 库的做法。
 */
import { useState, type JSX } from "react";
import { meaningfulCaps, type AuthMode } from "../../shared/index.ts";
import type { ConnectionViewWire, SeatSummary, TeamSummary } from "../../shared/wire.ts";
import { capsOf } from "./AgentsPage.tsx";
import { call, useAction } from "./api.ts";
import { libraryChanged, useLibrary } from "./library.ts";
import { t } from "./locale.ts";

/**
 * The auth mode a seat actually runs under. A seat naming no connection runs
 * on the host's own login, which is a subscription — a real choice, and the
 * caps that can bind it are the subscription ones.
 */
function modeOf(seat: SeatSummary, connections: readonly ConnectionViewWire[]): AuthMode {
  if (seat.connectionId === undefined) return "subscription";
  return connections.find((c) => c.connectionId === seat.connectionId)?.authMode ?? "subscription";
}

/** What this seat runs on, in words. */
function connectionLabel(seat: SeatSummary, connections: readonly ConnectionViewWire[]): string {
  if (seat.connectionId === undefined) return t("本机登录");
  const connection = connections.find((c) => c.connectionId === seat.connectionId);
  if (connection === undefined) return t("⚠️ 连接已删除");
  const model = connection.modelId === undefined ? "" : ` · ${connection.modelId}`;
  const key = connection.authMode === "api-key" && !connection.credentialConfigured ? ` · ⚠️ ${t("密钥未配置")}` : "";
  return `${connection.displayName}${model}${key}`;
}

function CapsEditor(props: {
  readonly seat: SeatSummary;
  readonly mode: AuthMode;
  readonly onSave: (raw: { maxTurns: string; maxTokens: string; maxCostUsd: string }) => void;
}): JSX.Element {
  const allowed = meaningfulCaps(props.mode);
  const [raw, setRaw] = useState({
    maxTurns: props.seat.caps?.maxTurns === undefined ? "" : String(props.seat.caps.maxTurns),
    maxTokens: props.seat.caps?.maxTokens === undefined ? "" : String(props.seat.caps.maxTokens),
    maxCostUsd: props.seat.caps?.maxCostUsd === undefined ? "" : String(props.seat.caps.maxCostUsd),
  });
  const label = { maxTurns: t("轮数上限"), maxTokens: t("token 上限"), maxCostUsd: t("花费上限 $") } as const;
  return (
    <>
      <div className="row-gap">
        {/* A cap that cannot bind is not rendered at all: a greyed-out field
            still reads as "a thing this seat has". */}
        {allowed.map((key) => (
          <input
            key={key}
            className="narrow"
            value={raw[key]}
            inputMode="decimal"
            placeholder={label[key]}
            onChange={(event) => setRaw({ ...raw, [key]: event.target.value })}
          />
        ))}
        <button type="button" onClick={() => props.onSave(raw)}>
          {t("存上限")}
        </button>
      </div>
      {props.mode === "subscription" && <div className="muted">{t("订阅模式不计费，所以没有花费上限。")}</div>}
    </>
  );
}

export function SeatEditor(props: { readonly team: TeamSummary; readonly onDisbanded: () => void }): JSX.Element {
  const { team } = props;
  const { library } = useLibrary();
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState("");
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const action = useAction();
  const connections = library?.connections ?? [];
  const agents = library?.agents ?? [];
  const busy = team.busy || team.commands.some((command) => command.state === "queued" || command.state === "running");

  /**
   * Removing the secretary asks first: a team with no secretary has folding
   * fall back to the host's own login, and the roster afterwards does not say
   * that is why.
   */
  const drop = (seat: SeatSummary): void => {
    const question = seat.isSecretary
      ? t("{name} 是秘书，删掉之后折叠讨论就改由本机 Claude Code 来做。继续？", { name: seat.displayName })
      : t("把 {name} 移出团队？它说过的话留在记录里。", { name: seat.displayName });
    if (!window.confirm(question)) return;
    void action.run(() =>
      call("seats.remove", {
        teamId: team.teamId,
        seatId: seat.seatId,
        ...(seat.isSecretary ? { confirmSecretary: true } : {}),
      }),
    );
  };

  const add = async (): Promise<void> => {
    const agent = agents.find((candidate) => candidate.templateId === adding);
    const done = await action.run(() =>
      call("seats.add", {
        teamId: team.teamId,
        templateId: adding,
        // Offered only when the library says this agent may be one and the
        // team has none; the host refuses it otherwise.
        ...(agent?.secretaryCandidate === true && team.seats.every((seat) => !seat.isSecretary)
          ? { isSecretary: true }
          : {}),
      }),
    );
    if (done !== undefined) setAdding("");
  };

  const disband = async (): Promise<void> => {
    const question =
      team.sessionCount > 1
        ? t(
            "归档「{name}」和它的全部 {n} 场会话？它们会从列表里拿下，记录留在磁盘上，可以在「归档」里恢复或删除。只想收起这一场，用上面的「归档这场」。",
            {
              name: team.displayName,
              n: team.sessionCount,
            },
          )
        : t("归档「{name}」？它会从列表里拿下，记录留在磁盘上，可以在「归档」里恢复或删除。", {
            name: team.displayName,
          });
    if (!window.confirm(question)) return;
    const done = await action.run(() => call("teams.disband", { teamId: team.teamId }));
    if (done !== undefined) props.onDisbanded();
  };

  return (
    <div className="panel">
      <div className="panel-title">{t("成员")}</div>
      {busy && <div className="muted">{t("有命令在跑，改名册要等它结束。")}</div>}
      {team.seats.map((seat) => (
        <div className="seat-card" key={seat.seatId}>
          <button
            type="button"
            className="seat-head"
            onClick={() => setExpanded(expanded === seat.seatId ? undefined : seat.seatId)}
          >
            <span className="dot" style={{ background: seat.color ?? "var(--text-3)" }} />
            <strong>
              {seat.isSecretary ? "★ " : ""}
              {seat.displayName}
            </strong>
            <span className="muted">{expanded === seat.seatId ? "▾" : "▸"}</span>
          </button>
          <div className="muted">
            {seat.role} · {seat.backend} · {connectionLabel(seat, connections)}
            {seat.permissionMode === undefined ? "" : ` · ${seat.permissionMode}`}
            {seat.reasoningEffort === undefined ? "" : ` · ${t("思考 {effort}", { effort: seat.reasoningEffort })}`}
          </div>
          {/* Said before the round, not after it fails. */}
          {seat.problem !== undefined && <div className="notice inline">⚠️ {seat.problem}</div>}
          {expanded === seat.seatId && (
            <div className="seat-body">
              <label className="field">
                <span>{t("连接")}</span>
                <select
                  value={seat.connectionId ?? ""}
                  onChange={(event) =>
                    void action.run(() =>
                      call("seats.patch", {
                        teamId: team.teamId,
                        seatId: seat.seatId,
                        connectionId: event.target.value,
                      }),
                    )
                  }
                >
                  <option value="">{t("本机登录")}</option>
                  {connections
                    .filter((connection) => connection.backend === seat.backend)
                    .map((connection) => (
                      <option key={connection.connectionId} value={connection.connectionId}>
                        {connection.displayName}
                        {connection.modelId === undefined ? "" : ` · ${connection.modelId}`}
                      </option>
                    ))}
                  {seat.connectionId !== undefined &&
                    !connections.some((connection) => connection.connectionId === seat.connectionId) && (
                      <option value={seat.connectionId}>{t("⚠️ 已删除的连接")}</option>
                    )}
                </select>
              </label>
              <CapsEditor
                key={JSON.stringify(seat.caps ?? {})}
                seat={seat}
                mode={modeOf(seat, connections)}
                onSave={(raw) =>
                  void action.run(() =>
                    call("seats.patch", {
                      teamId: team.teamId,
                      seatId: seat.seatId,
                      // An empty object clears every cap.
                      caps: capsOf(raw, modeOf(seat, connections)) ?? {},
                    }),
                  )
                }
              />
              <label className="field">
                <span>{t("重新关联到 Agent 库里的…（拿它的全部设置，位置和秘书身份不变）")}</span>
                <select
                  value=""
                  onChange={(event) => {
                    const templateId = event.target.value;
                    if (templateId === "") return;
                    void action.run(() =>
                      call("seats.relink", { teamId: team.teamId, seatId: seat.seatId, templateId }),
                    );
                  }}
                >
                  <option value="">{seat.templateId === undefined ? t("（手写的席位）选一个…") : t("选一个…")}</option>
                  {agents.map((agent) => (
                    <option key={agent.templateId} value={agent.templateId}>
                      {agent.displayName} · {agent.role}
                      {agent.templateId === seat.templateId ? t("（当前）") : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => drop(seat)}>
                {t("移出团队")}
              </button>
            </div>
          )}
        </div>
      ))}

      <div className="row-gap">
        <select value={adding} onChange={(event) => setAdding(event.target.value)}>
          <option value="">{t("从 Agent 库里加人…")}</option>
          {agents.map((agent) => (
            <option key={agent.templateId} value={agent.templateId}>
              {agent.displayName} · {agent.role}
              {agent.secretaryCandidate ? " ★" : ""}
            </option>
          ))}
        </select>
        <button type="button" disabled={adding === "" || action.busy} onClick={() => void add()}>
          {t("加进来")}
        </button>
      </div>
      {action.error !== undefined && <div className="error">{action.error}</div>}

      <div className="panel-title" style={{ marginTop: 14 }}>
        {t("这支团队")}
      </div>
      {renaming === undefined ? (
        <div className="row-gap">
          <button type="button" onClick={() => setRenaming(team.displayName)}>
            {t("改名")}
          </button>
          <button type="button" onClick={() => void disband()}>
            {t("归档")}
          </button>
        </div>
      ) : (
        <div className="row-gap">
          <input value={renaming} onChange={(event) => setRenaming(event.target.value)} />
          <button
            type="button"
            onClick={() =>
              void action
                .run(() => call("teams.rename", { teamId: team.teamId, displayName: renaming }))
                .then((done) => {
                  if (done !== undefined) {
                    setRenaming(undefined);
                    libraryChanged();
                  }
                })
            }
          >
            {t("保存")}
          </button>
          <button type="button" onClick={() => setRenaming(undefined)}>
            {t("取消")}
          </button>
        </div>
      )}
    </div>
  );
}
