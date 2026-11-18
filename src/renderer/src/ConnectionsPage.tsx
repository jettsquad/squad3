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
import { useState, type JSX } from "react";
import { credentialRefFor, isOwnModel, type AuthMode, type ConnectionBackend } from "../../shared/index.ts";
import type { ConnectionViewWire, ConnectionWire } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { BACKEND_LABELS, libraryChanged, useLibrary } from "./library.ts";
import { t } from "./locale.ts";
import type { CloudConnection } from "../../shared/connection.ts";

const emptyCloud = (): CloudConnection => ({
  host: "",
  port: 22,
  user: "root",
  identityFile: "",
  knownHostsFile: "",
  executable: "/opt/octopus-g0/bin/codex-minimax",
  runAs: "octopus-g0",
  revision: "1",
});

export function ConnectionsPage(): JSX.Element {
  const { library, error: loadError } = useLibrary();
  /**
   * The connection being edited, or `undefined` for a new one. Editing keeps
   * the id, so the agents pointing at it stay attached; delete-and-recreate
   * would orphan every one of them.
   */
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<AuthMode>("subscription");
  const [backend, setBackend] = useState<ConnectionBackend>("claude-code");
  const [source, setSource] = useState<"local" | "octopus">("local");
  const [cloud, setCloud] = useState<CloudConnection>(emptyCloud);
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
    setBackend(connection.backend);
    setSource(connection.source ?? "local");
    setCloud(connection.cloud ?? emptyCloud());
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
    setMode("subscription");
    setModel("");
    setBackend("claude-code");
    setSource("local");
    setCloud(emptyCloud());
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
      backend,
      source,
      ...(source === "octopus" ? { cloud } : {}),
      ...(model.trim() === "" ? {} : { modelId: model.trim() }),
      ...(source === "local" && mode === "api-key" && endpoint.trim() !== "" ? { endpoint: endpoint.trim() } : {}),
      // Derived unless the person named an existing secret: they have a key,
      // and the filing is the system's job.
      ...(source === "octopus" || mode !== "api-key"
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
        ...(source === "local" && mode === "api-key" && !existing && key !== "" ? { credential: key } : {}),
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
        <p className="muted">
          {t(
            "连接可选择本地或云端来源。现有本地登录和 API 配置继续使用；云端模型凭据留在服务器，业务工具在团队项目目录执行。",
          )}
        </p>
        {loadError !== undefined && <div className="error">{loadError}</div>}

        {connections.length === 0 && library !== undefined && (
          <p className="muted">{t("还没有连接。不建也行——Agent 默认用本机登录。")}</p>
        )}
        {connections.map((connection) => (
          <div className="list-row" key={connection.connectionId}>
            <strong>{connection.displayName}</strong>
            <span className="muted">
              {BACKEND_LABELS[connection.backend] ?? connection.backend} ·{" "}
              {connection.source === "octopus"
                ? `${t("云端")} · ${connection.cloud?.host ?? ""} · `
                : `${t("本地")} · `}
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
            <button type="button" className="link" onClick={() => edit(connection)}>
              {t("编辑")}
            </button>
            <button type="button" className="link danger" onClick={() => void remove(connection)}>
              {t("删除")}
            </button>
          </div>
        ))}

        <div className="card">
          <div className="card-title">{editing === undefined ? t("新建连接") : t("编辑「{name}」", { name })}</div>
          <div className="seat-row">
            <input value={name} placeholder={t("连接名")} onChange={(event) => setName(event.target.value)} />
            <select
              aria-label={t("运行来源")}
              value={source}
              onChange={(event) => {
                const next = event.target.value as "local" | "octopus";
                setSource(next);
                if (next === "octopus") {
                  setBackend("codex");
                  setMode("api-key");
                }
              }}
            >
              <option value="local">{t("本地")}</option>
              <option value="octopus">{t("云端（SSH）")}</option>
            </select>
            <select
              value={backend}
              disabled={source === "octopus"}
              onChange={(event) => setBackend(event.target.value as ConnectionBackend)}
            >
              <option value="claude-code">Claude Code</option>
              <option value="codex">{t("Codex（ChatGPT / OpenAI）")}</option>
              <option value="dsh">DeepSeek Harness</option>
            </select>
            {source !== "local" ? (
              <span className="muted">{t("模型认证由云端配置")}</span>
            ) : (
              <select value={mode} onChange={(event) => setMode(event.target.value as AuthMode)}>
                <option value="subscription">{t("订阅（用本机 CLI 的登录态）")}</option>
                <option value="api-key">API key</option>
              </select>
            )}
          </div>
          <div className="seat-row">
            <input
              value={model}
              placeholder={
                source === "octopus"
                  ? t("模型（留空沿用云端配置）")
                  : mode === "subscription"
                    ? t("模型（只能是 {backend} 自家的）", { backend })
                    : t("模型")
              }
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
          {source !== "octopus" ? null : (
            <>
              <div className="seat-row">
                <input
                  aria-label={t("SSH 主机")}
                  placeholder={t("SSH 主机")}
                  value={cloud.host}
                  onChange={(e) => setCloud({ ...cloud, host: e.target.value.trim() })}
                />
                <input
                  aria-label={t("SSH 端口")}
                  type="number"
                  value={cloud.port}
                  onChange={(e) => setCloud({ ...cloud, port: Number(e.target.value) })}
                />
                <input
                  aria-label={t("SSH 用户")}
                  placeholder={t("SSH 用户")}
                  value={cloud.user}
                  onChange={(e) => setCloud({ ...cloud, user: e.target.value.trim() })}
                />
              </div>
              <div className="seat-row">
                <input
                  aria-label={t("本机 SSH 私钥路径")}
                  placeholder={t("本机 SSH 私钥路径")}
                  value={cloud.identityFile}
                  onChange={(e) => setCloud({ ...cloud, identityFile: e.target.value })}
                />
              </div>
              <div className="seat-row">
                <input
                  aria-label={t("本机 known_hosts 路径")}
                  placeholder={t("本机 known_hosts 路径")}
                  value={cloud.knownHostsFile}
                  onChange={(e) => setCloud({ ...cloud, knownHostsFile: e.target.value })}
                />
              </div>
              <div className="seat-row">
                <input
                  aria-label={t("云端运行程序")}
                  placeholder={t("云端运行程序")}
                  value={cloud.executable}
                  onChange={(e) => setCloud({ ...cloud, executable: e.target.value.trim() })}
                />
                <input
                  aria-label={t("云端运行用户")}
                  placeholder={t("云端运行用户")}
                  value={cloud.runAs}
                  onChange={(e) => setCloud({ ...cloud, runAs: e.target.value.trim() })}
                />
                <input
                  aria-label={t("远端配置版本")}
                  placeholder={t("远端配置版本")}
                  value={cloud.revision}
                  onChange={(e) => setCloud({ ...cloud, revision: e.target.value.trim() })}
                />
              </div>
              <p className="muted">
                {t(
                  "沿用席位权限和团队目录。更换云端账户后请递增远端配置版本；云端故障会明确报错，不自动改用本地模型。",
                )}
              </p>
            </>
          )}
          {source !== "local" || mode !== "api-key" ? null : (
            <>
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
          {source !== "local" ||
          mode !== "subscription" ||
          model.trim() === "" ||
          isOwnModel(backend, model.trim()) ? null : (
            <p className="notice inline">
              {t(
                "「{model}」不是 {backend} 自家的模型。订阅模式用的是本机 CLI 的登录态，这个名字会被发到那个端点，报出来的错会指向模型而不是这个不匹配。要用它就选 API key，填它自己的地址和密钥。",
                { model: model.trim(), backend },
              )}
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
