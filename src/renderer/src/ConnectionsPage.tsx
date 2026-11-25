/**
 * ConnectionsPage.tsx — the connection library.
 *
 * 移植自 Squad 2.x packages/console/src/client/connections.tsx @ 8dcb903
 * 改动：文案直接写中文（多语言在阶段 3c）；「没有席位后端认领它」不再需要——3 的三个后端都有适配器。
 *
 * The API key field is write-only. It sends a value and never receives one:
 * the list carries `credentialConfigured`, so the badge can say 「已配置」
 * without a secret ever reaching this window.
 *
 * Endpoint and key appear only under api-key mode, because under
 * subscription the host REFUSES both — 「订阅模式不使用自定义端点」. Showing a
 * field whose value will be rejected teaches that the form is unreliable.
 */
import { useEffect, useState, type JSX } from "react";
import {
  credentialRefFor,
  defaultHarnessForConnection,
  inferenceProtocol,
  INFERENCE_PROTOCOLS,
  INFERENCE_PROTOCOL_LABELS,
  isOwnModel,
  type AuthMode,
  type InferenceProtocol,
} from "../../shared/connection.ts";
import type { ConnectionViewWire, ConnectionWire, MethodOutput } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { libraryChanged, useLibrary } from "./library.ts";
import { t } from "./locale.ts";

function Quota({ connectionId }: { connectionId: string }): JSX.Element {
  const action = useAction();
  const [quota, setQuota] = useState<MethodOutput<"connections.quota">>();
  return (
    <div className="card">
      <button
        type="button"
        disabled={action.busy}
        onClick={() =>
          void action.run(async () => {
            setQuota(undefined);
            setQuota(await call("connections.quota", { connectionId }));
          })
        }
      >
        {t(action.busy ? "正在查询额度…" : "查询订阅额度")}
      </button>
      {quota?.windows.map((window, index) => (
        <p key={index}>
          {window.label} · {t("剩余 {percent}%", { percent: Number(window.remainingPercent.toFixed(1)) })}
          {window.resetsAt !== undefined && ` · ${t("重置时间")} ${new Date(window.resetsAt).toLocaleString()}`}
        </p>
      ))}
      {quota && (
        <p className="muted">
          {t("查询时间")} {new Date(quota.checkedAt).toLocaleString()}
        </p>
      )}
      {action.error && <p className="error">{action.error}</p>}
    </div>
  );
}

function CloudActivation({ initialError }: { initialError?: string | undefined }): JSX.Element {
  const action = useAction();
  return (
    <div className="card">
      <strong>{t("云端 Agent")}</strong>
      <p>{t("云端 MiniMax 首次开通后可试用 10 天。")}</p>
      <button
        type="button"
        disabled={action.busy}
        onClick={() =>
          void action.run(async () => {
            await call("connections.activateCloud", {});
            libraryChanged();
          })
        }
      >
        {t("重试开通云端 Agent")}
      </button>
      {(action.error ?? initialError) && <p className="error">{action.error ?? initialError}</p>}
    </div>
  );
}

function CloudSubscription({ connectionId }: { connectionId: string }): JSX.Element {
  const action = useAction();
  const [term, setTerm] = useState<"month" | "year">("month");
  const [status, setStatus] = useState<MethodOutput<"connections.subscription">>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    let live = true;
    void call("connections.subscription", { connectionId }).then(
      (value) => {
        if (live) setStatus(value);
      },
      (error: unknown) => {
        if (live) setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      live = false;
    };
  }, [connectionId]);
  const refresh = (selected?: "month" | "year"): void => {
    void action.run(async () => {
      setLoadError(undefined);
      setStatus(await call("connections.subscription", { connectionId, term: selected }));
    });
  };
  const request = status?.request;
  const eligible =
    status !== undefined &&
    status.expiresAt !== null &&
    (status.state === "active" || status.state === "expired") &&
    request?.status !== "pending";
  return (
    <div className="card">
      <strong>{t("云端 Agent 订阅")}</strong>
      {status && (
        <p>
          {t({ active: "授权有效", paused: "授权已暂停", revoked: "授权已撤销", expired: "授权已到期" }[status.state])}
          {" · "}
          {status.expiresAt === null
            ? t("长期有效")
            : t("到期时间 {date}", { date: new Date(status.expiresAt).toLocaleString() })}
          {status.expiresAt !== null &&
            status.state === "active" &&
            ` · ${t("剩余 {days} 天", { days: Math.max(0, Math.ceil((status.expiresAt - Date.now()) / 86400000)) })}`}
        </p>
      )}
      {request && (
        <p>
          {t(request.term === "month" ? "1 个月" : "1 年")} ·{" "}
          {t(
            {
              pending: "待审核",
              approved: "申请已批准",
              rejected: "申请已拒绝",
            }[request.status],
          )}
        </p>
      )}
      <div className="seat-row">
        <select
          aria-label={t("申请期限")}
          disabled={!eligible || action.busy}
          value={term}
          onChange={(event) => setTerm(event.target.value === "year" ? "year" : "month")}
        >
          <option value="month">{t("1 个月")}</option>
          <option value="year">{t("1 年")}</option>
        </select>
        <button type="button" disabled={!eligible || action.busy} onClick={() => refresh(term)}>
          {t("申请订阅")}
        </button>
        <button type="button" disabled={action.busy} onClick={() => refresh()}>
          {t("刷新状态")}
        </button>
      </div>
      {(action.error ?? loadError) && <p className="error">{action.error ?? loadError}</p>}
    </div>
  );
}

export function ConnectionsPage({ initialCloudError }: { initialCloudError?: string | undefined }): JSX.Element {
  const { library, error: loadError } = useLibrary();
  /**
   * The connection being edited, or `undefined` for a new one. Editing keeps
   * the id, so the agents pointing at it stay attached; delete-and-recreate
   * would orphan every one of them.
   */
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<AuthMode>("api-key");
  const [protocol, setProtocol] = useState<InferenceProtocol>("anthropic-messages");
  const [authHeader, setAuthHeader] = useState<"x-api-key" | "bearer">("x-api-key");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [key, setKey] = useState("");
  /**
   * Whether the secret already lives under a name of its own. Off is the
   * ordinary case: you have a key, you paste it, and the name it is filed
   * under is derived. On is the case where the name is the point — the key is
   * already an environment variable.
   */
  const [existing, setExisting] = useState(false);
  /** The name the edited connection's key is filed under now, kept when no new key is typed. */
  const [storedRef, setStoredRef] = useState<string | undefined>(undefined);
  const action = useAction();

  /** Load an existing connection into the form. Never its key: there is none to load. */
  const edit = (connection: ConnectionViewWire): void => {
    setEditing(connection.connectionId);
    setName(connection.displayName);
    setProtocol(inferenceProtocol(connection) ?? "anthropic-messages");
    setAuthHeader(connection.authHeader ?? "x-api-key");
    setMode(connection.authMode);
    setModel(connection.modelId ?? "");
    setEndpoint(connection.endpoint ?? "");
    setCredentialRef(connection.credentialRef ?? "");
    setStoredRef(connection.credentialRef);
    setKey("");
    // 「已在环境变量里」 only for a name the person chose. A `SQUAD_…` name is
    // one Squad filed the key under itself (possibly another connection's,
    // shared from 2.x); opening that in the variable-name box invited pasting
    // the key there (2026-10-23).
    setExisting(connection.credentialRef !== undefined && !connection.credentialRef.startsWith("SQUAD_"));
  };

  const clear = (): void => {
    setEditing(undefined);
    setName("");
    setMode("api-key");
    setModel("");
    setProtocol("anthropic-messages");
    setAuthHeader("x-api-key");
    setEndpoint("");
    setCredentialRef("");
    setStoredRef(undefined);
    setKey("");
    setExisting(false);
  };

  const save = async (): Promise<void> => {
    const connectionId = editing ?? `conn-${Date.now().toString(36)}`;
    const connection: ConnectionWire = {
      connectionId,
      displayName: name.trim(),
      authMode: mode,
      protocol,
      source: "local",
      ...(model.trim() === "" ? {} : { modelId: model.trim() }),
      ...(mode === "api-key" && endpoint.trim() !== "" ? { endpoint: endpoint.trim() } : {}),
      ...(mode === "api-key" && protocol === "anthropic-messages" ? { authHeader } : {}),
      // Derived unless the person named an existing secret: they have a key,
      // and the filing is the system's job.
      ...(mode !== "api-key"
        ? {}
        : {
            credentialRef:
              existing && credentialRef.trim() !== ""
                ? credentialRef.trim()
                : // No new key typed: leave the key where it is filed (a shared one stays shared).
                  !existing && key === "" && storedRef !== undefined
                  ? storedRef
                  : credentialRefFor(connectionId),
          }),
    };
    const saved = await action.run(() =>
      call("connections.save", {
        connection,
        ...(mode === "api-key" && !existing && key !== "" ? { credential: key } : {}),
      }),
    );
    if (saved === undefined) return;
    libraryChanged();
    clear();
  };

  const remove = async (connection: ConnectionViewWire): Promise<void> => {
    if (
      !window.confirm(
        t(
          connection.source === "octopus"
            ? "删除云端连接「{name}」？服务器上的模型配置保留。"
            : "删除连接「{name}」？存在这里的密钥也一起删掉。",
          { name: connection.displayName },
        ),
      )
    )
      return;
    const done = await action.run(() => call("connections.remove", { connectionId: connection.connectionId }));
    if (done !== undefined) {
      libraryChanged();
      if (editing === connection.connectionId) clear();
    }
  };

  const connections = library?.connections ?? [];
  return (
    <main className="main scroll">
      <div className="page">
        <h2>{t("连接")}</h2>
        <p className="muted">{t("连接只管理推理来源与凭据。本机 Harness 在 Agent 库里选择。")}</p>
        {!connections.some(
          (connection) => connection.cloud?.managedDeviceId !== undefined && connection.cloud.port !== 22,
        ) && <CloudActivation initialError={initialCloudError} />}
        {loadError !== undefined && <div className="error">{loadError}</div>}

        {connections.length === 0 && library !== undefined && (
          <p className="muted">{t("还没有连接。不建也行——Agent 默认用本机登录。")}</p>
        )}
        {connections.map((connection) => (
          <div key={connection.connectionId}>
            <div className="list-row">
              <strong>{connection.displayName}</strong>
              <span className="muted">
                {connection.source === "octopus"
                  ? "Octopus Agent"
                  : INFERENCE_PROTOCOL_LABELS[inferenceProtocol(connection) ?? "anthropic-messages"]}{" "}
                · {connection.source === "octopus" && `${t("云端")} · ${connection.cloud?.host ?? ""} · `}
                {connection.authMode === "subscription" ? t("订阅") : "API key"}
                {connection.modelId === undefined ? "" : ` · ${connection.modelId}`}
                {connection.endpoint === undefined ? "" : ` · ${connection.endpoint}`}
              </span>
              {connection.source === "octopus" ? (
                <span className="badge">{t("模型凭据在云端")}</span>
              ) : connection.authMode !== "api-key" ? null : connection.credentialProblem !== undefined ? (
                <span className="badge bad" title={connection.credentialProblem}>
                  {t("凭据名不合法，点「编辑」重新填 key")}
                </span>
              ) : connection.credentialConfigured ? (
                <span className="badge ok">{t("密钥已配置")}</span>
              ) : connection.credentialWritable ? (
                <span className="badge bad">{t("密钥未配置")}</span>
              ) : (
                // `set` refuses while a read-only source shadows the name, so the
                // key box would silently keep failing without this.
                <span className="badge bad">
                  {t("密钥名「{name}」被只读来源占了，这里改不了", { name: connection.credentialRef ?? "" })}
                </span>
              )}
              <span style={{ flex: 1 }} />
              {connection.source !== "octopus" && (
                <button type="button" className="link" onClick={() => edit(connection)}>
                  {t("编辑")}
                </button>
              )}
              <button type="button" className="link danger" onClick={() => void remove(connection)}>
                {t("删除")}
              </button>
            </div>
            {connection.cloud?.managedDeviceId !== undefined && (
              <CloudSubscription connectionId={connection.connectionId} />
            )}
            {connection.source === "octopus" && connection.cloud?.quotaProvider !== undefined && (
              <Quota key={JSON.stringify(connection.cloud)} connectionId={connection.connectionId} />
            )}
          </div>
        ))}

        <div className="card">
          <div className="card-title">{editing === undefined ? t("新建连接") : t("编辑「{name}」", { name })}</div>
          <div className="seat-row">
            <input value={name} placeholder={t("连接名")} onChange={(event) => setName(event.target.value)} />
            <select
              aria-label={t("API 协议")}
              value={protocol}
              onChange={(event) => {
                const next = event.target.value as InferenceProtocol;
                setProtocol(next);
                if (next === "openai-completions") setMode("api-key");
              }}
            >
              {INFERENCE_PROTOCOLS.map((value) => (
                <option value={value} key={value}>
                  {t(INFERENCE_PROTOCOL_LABELS[value])}
                </option>
              ))}
            </select>
            <select value={mode} onChange={(event) => setMode(event.target.value as AuthMode)}>
              <option value="subscription" disabled={protocol === "openai-completions"}>
                {t("订阅（使用已有登录）")}
              </option>
              <option value="api-key">API key</option>
            </select>
          </div>
          <div className="seat-row">
            <input value={model} placeholder={t("模型 ID")} onChange={(event) => setModel(event.target.value)} />
          </div>
          {mode !== "api-key" ? null : (
            <>
              {protocol === "anthropic-messages" && (
                <label className="field">
                  <span>{t("认证请求头")}</span>
                  <select
                    value={authHeader}
                    onChange={(event) => setAuthHeader(event.target.value === "bearer" ? "bearer" : "x-api-key")}
                  >
                    <option value="x-api-key">x-api-key</option>
                    <option value="bearer">Authorization: Bearer</option>
                  </select>
                </label>
              )}
              <div className="seat-row">
                <input
                  value={endpoint}
                  placeholder={t("接口地址（留空用默认）")}
                  onChange={(event) => setEndpoint(event.target.value)}
                />
                {existing ? (
                  <input
                    value={credentialRef}
                    placeholder={t("环境变量名，如 DEEPSEEK_API_KEY")}
                    onChange={(event) => setCredentialRef(event.target.value)}
                  />
                ) : (
                  <input
                    type="password"
                    value={key}
                    placeholder={t("API key（只写入，永不回显）")}
                    autoComplete="off"
                    onChange={(event) => setKey(event.target.value)}
                  />
                )}
              </div>
              <label className="check">
                <input type="checkbox" checked={existing} onChange={(event) => setExisting(event.target.checked)} />
                {t("这把 key 已经在环境变量里了")}
              </label>
              <p className="muted">
                {existing
                  ? t("填变量名，不填值——每次启动席位时按这个名字去取，所以你在别处换了 key，下一轮就生效。")
                  : t(
                      "key 用系统加密（Windows DPAPI / macOS 钥匙串）存在本机，配置里只留一个名字。填过之后不会再显示出来。",
                    )}
              </p>
            </>
          )}
          {/* Said before the save: the host refuses a foreign model on a
              subscription, and that reason is actionable only while the field
              is still in front of the person. */}
          {mode !== "subscription" ||
          model.trim() === "" ||
          isOwnModel(
            defaultHarnessForConnection({
              connectionId: "draft",
              displayName: "",
              authMode: mode,
              protocol,
            }) ?? "codex",
            model.trim(),
          ) ? null : (
            <p className="notice inline">
              {t("「{model}」不属于所选登录提供方。要使用它，请选择 API key 并填写提供方的地址和密钥。", {
                model: model.trim(),
              })}
            </p>
          )}
          {action.error !== undefined && <div className="error">{action.error}</div>}
          <div className="row-gap">
            <button type="button" className="primary" onClick={() => void save()} disabled={action.busy}>
              {editing === undefined ? t("新建连接") : t("保存修改")}
            </button>
            {editing === undefined ? null : (
              <>
                <button type="button" onClick={clear}>
                  {t("取消编辑")}
                </button>
                <span className="muted">{t("密钥留空就是不动已存的那把。要换就直接填新的。")}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
