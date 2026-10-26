/**
 * SettingsPage.tsx — what is true of the person, not of any team.
 *
 * 移植自 Squad 2.x packages/console/src/client/me.tsx @ 8dcb903
 * 改动：多一项 dsh 的位置（3 不再跑在 dsh 里，dsh 只是一个席位后端，常常不在 PATH 上）；
 * 多一项界面语言（2.x 跟着 dsh 的语言走，3 自己管）。
 * 「完成提醒」在阶段 5 回来：Electron 的系统通知，三个平台都有；窗口在最前面时不弹。
 * 「朗读」「听写」两节在阶段 5 回来（2.x 的朗读设置在团队页的 ListenBar 里、存在浏览器里；
 * 3 是一个桌面程序，放到这里、存进设置）。
 * 「谁来蒸馏你的判据」在阶段 4 回来，多一项判据库放在哪；「完成提醒」在阶段 5 回来——
 * 在那之前不摆出来：一个存得下、却不起作用的开关，正是这个项目一直在消灭的东西。
 */
import { useEffect, useState, type JSX } from "react";
import { call, useAction } from "./api.ts";
import { ImportPanel } from "./ImportPanel.tsx";
import { libraryChanged, useLibrary } from "./library.ts";
import { systemLanguage, t } from "./locale.ts";
import { openPage } from "./Voice.tsx";
import type { ConnectionViewWire } from "../../shared/wire.ts";

export function SettingsPage(): JSX.Element {
  const { library, error: loadError } = useLibrary();
  const saved = library?.settings;
  const connections = library?.connections ?? [];
  const [name, setName] = useState("");
  const [dsh, setDsh] = useState("");
  const [folder, setFolder] = useState("");
  const [model, setModel] = useState("");
  const [info, setInfo] = useState<{ version: string; dataDir: string } | undefined>(undefined);
  const action = useAction();

  // Re-seeded when the stored value changes, so a stale box never overwrites a newer value.
  useEffect(() => {
    setName(saved?.hostDisplayName ?? "");
  }, [saved?.hostDisplayName]);
  useEffect(() => {
    setDsh(saved?.dshCommand ?? "");
  }, [saved?.dshCommand]);
  useEffect(() => {
    setFolder(saved?.criteriaFolder ?? "");
  }, [saved?.criteriaFolder]);
  useEffect(() => {
    setModel(saved?.dictationModel ?? "");
  }, [saved?.dictationModel]);
  // As a percentage, re-seeded from the stored value.
  const [scale, setScale] = useState(100);
  useEffect(() => {
    setScale(Math.round((saved?.fontScale ?? 1) * 100));
  }, [saved?.fontScale]);
  useEffect(() => {
    void call("app.info", {}).then(setInfo, () => undefined);
  }, []);

  // Speech and dictation call a provider's API with the connection's own key;
  // a connection without one is listed, but says so (imports from 2.x carry no keys).
  const keyMissing = (connection: ConnectionViewWire): boolean =>
    connection.authMode === "api-key" && !connection.credentialConfigured;
  const connectionOption = (connection: ConnectionViewWire): JSX.Element => (
    <option
      key={connection.connectionId}
      value={connection.connectionId}
      className={keyMissing(connection) ? "unready" : undefined}
    >
      {connection.displayName}
      {keyMissing(connection) ? t("（密钥未配置）") : ""}
    </option>
  );
  const speechConnection = connections.find((one) => one.connectionId === saved?.speechConnectionId);
  const speechKeyMissing = speechConnection !== undefined && keyMissing(speechConnection);

  const save = async (patch: {
    hostDisplayName?: string;
    dshCommand?: string;
    language?: "zh" | "en";
    theme?: "system" | "light" | "dark";
    fontScale?: number;
    distilConnectionId?: string;
    criteriaFolder?: string;
    speechConnectionId?: string;
    speechSpeed?: number;
    dictationConnectionId?: string;
    dictationModel?: string;
    notifyOnFinish?: boolean;
  }): Promise<void> => {
    await action.run(() => call("settings.save", patch));
    libraryChanged();
  };

  return (
    <main className="main scroll">
      <div className="page">
        <h2>{t("设置")}</h2>
        <p className="muted">{t("这里是关于你的设置，跟任何一个团队无关——换个项目也还是这些。")}</p>
        {loadError !== undefined && <div className="error">{loadError}</div>}

        <div className="section-title">{t("界面语言")}</div>
        <div className="row-gap">
          <select
            value={saved?.language ?? systemLanguage()}
            onChange={(event) => void save({ language: event.target.value as "zh" | "en" })}
          >
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </div>
        {/* What the language does not reach, said where it is chosen. */}
        <p className="muted">{t("只换界面。席位说过的话和主进程报出的原话不翻译——那是记录。")}</p>

        <div className="section-title">{t("外观")}</div>
        <div className="row-gap">
          <select
            value={saved?.theme ?? "system"}
            onChange={(event) => void save({ theme: event.target.value as "system" | "light" | "dark" })}
          >
            <option value="system">{t("跟随系统")}</option>
            <option value="light">{t("浅色")}</option>
            <option value="dark">{t("暗色")}</option>
          </select>
        </div>
        <div className="row-gap font-scale">
          <span>{t("字体大小")}</span>
          <span className="muted">A</span>
          <input
            type="range"
            min={80}
            max={160}
            step={5}
            value={scale}
            aria-label={t("字体大小")}
            onChange={(event) => {
              // Drawn at once while dragging; written when the hand lets go.
              setScale(Number(event.target.value));
              void call("settings.save", { fontScale: Number(event.target.value) / 100 });
            }}
            onPointerUp={() => libraryChanged()}
            onKeyUp={() => libraryChanged()}
          />
          <span style={{ fontSize: 18 }}>A</span>
          <span className="muted">{scale}%</span>
          <button
            type="button"
            className="link"
            disabled={scale === 100}
            onClick={() => {
              setScale(100);
              void save({ fontScale: 1 });
            }}
          >
            {t("恢复默认")}
          </button>
        </div>
        <p className="muted">{t("整个窗口里的字一起变大变小：对话、标题、左栏和按钮。")}</p>

        <div className="section-title">{t("席位怎么称呼你")}</div>
        <div className="row-gap">
          <input
            value={name}
            placeholder={t("主持人")}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            disabled={name.trim() === (saved?.hostDisplayName ?? "") || action.busy}
            onClick={() => void save({ hostDisplayName: name })}
          >
            {t("保存")}
          </button>
        </div>
        {/* Said where the change is made: renaming does not rewrite history. */}
        <p className="muted">{t("新建团队时会用这个名字。已经存在的团队保持原样——改名不会重写已经记录下来的发言。")}</p>

        <div className="section-title">{t("dsh 在哪")}</div>
        <div className="row-gap">
          <input
            value={dsh}
            placeholder={t("留空就在 PATH 上找 dsh")}
            onChange={(event) => setDsh(event.target.value)}
          />
          <button
            type="button"
            disabled={dsh.trim() === (saved?.dshCommand ?? "") || action.busy}
            onClick={() => void save({ dshCommand: dsh.trim() })}
          >
            {t("保存")}
          </button>
        </div>
        <p className="muted">
          {t(
            "dsh 的可执行文件，或者 DeepSeek Harness 的 apps\\cli\\lib\\bin.js。用 node 跑 dsh 的人通常没把它链到 PATH 上，这里填上就行。每个 dsh 席位开跑时读它，改了下一轮就生效；到 Agent 库里点「测试」可以确认找得到。",
          )}
        </p>

        <div className="section-title">{t("完成提醒")}</div>
        <label className="check">
          <input
            type="checkbox"
            checked={saved?.notifyOnFinish !== false}
            onChange={(event) => void save({ notifyOnFinish: event.target.checked })}
          />
          {t("一轮答完、议程停下来等你、或者有条命令久没动静时，弹一条系统通知")}
        </label>
        <p className="muted">{t("窗口在最前面时不弹——你正看着的东西不用再告诉你。点通知会回到那支团队。")}</p>

        <div className="section-title">{t("朗读")}</div>
        <div className="row-gap">
          <select
            value={saved?.speechConnectionId ?? ""}
            onChange={(event) => void save({ speechConnectionId: event.target.value })}
          >
            <option value="">{t("不朗读")}</option>
            {connections.map(connectionOption)}
          </select>
          <select
            value={String(saved?.speechSpeed ?? 1)}
            onChange={(event) => void save({ speechSpeed: Number(event.target.value) })}
          >
            {[0.8, 1, 1.25, 1.5, 2].map((value) => (
              <option key={value} value={value}>
                {value}×
              </option>
            ))}
          </select>
        </div>
        <p className="muted">
          {t(
            "用 MiniMax 的语音合成：选一个 MiniMax 的 API key 连接（地址填 MiniMax 的，例如 https://api.minimaxi.com/anthropic）。选好之后，每条发言旁边的 ▶ 就能单独念那一条；代码块和表格会念成一句「略过」。每个 agent 的声音在 Agent 库里选。",
          )}
        </p>

        <div className="section-title">{t("听写")}</div>
        <div className="row-gap">
          <select
            value={saved?.dictationConnectionId ?? ""}
            onChange={(event) => void save({ dictationConnectionId: event.target.value })}
          >
            <option value="">{t("不听写")}</option>
            {connections.map(connectionOption)}
          </select>
          <input
            value={model}
            placeholder={t("模型名，例如 whisper-1")}
            onChange={(event) => setModel(event.target.value)}
          />
          <button
            type="button"
            disabled={model.trim() === (saved?.dictationModel ?? "") || action.busy}
            onClick={() => void save({ dictationModel: model.trim() })}
          >
            {t("保存")}
          </button>
        </div>
        <p className="muted">
          {t(
            "输入框旁边的 🎤：说完点一下，录音交给这里选的语音转文字服务，文字填进输入框——只填不发。要一个 OpenAI 兼容的 API key 连接（地址以 /v1 结尾，例如 OpenAI、硅基流动），模型名照那家写。录音只发给这一家，不经过别处。",
          )}
        </p>

        <div className="section-title">{t("谁来蒸馏你的判据")}</div>
        <div className="row-gap">
          <select
            value={saved?.distilConnectionId ?? ""}
            onChange={(event) => void save({ distilConnectionId: event.target.value })}
          >
            <option value="">{t("本机登录（Claude Code）")}</option>
            {(library?.connections ?? []).map((connection) => (
              <option key={connection.connectionId} value={connection.connectionId}>
                {connection.displayName}
              </option>
            ))}
          </select>
        </div>
        <p className="muted">
          {t(
            "Lil X 把你推翻机器提议的时刻提炼成判据，议程由它代理时也用这个连接替你决定。选一个便宜快的就够。选的连接被删了，就退回本机登录。",
          )}
        </p>
        <div className="row-gap">
          <input
            value={folder}
            placeholder={t("留空就放在数据目录的 criteria 里")}
            onChange={(event) => setFolder(event.target.value)}
          />
          <button
            type="button"
            disabled={folder.trim() === (saved?.criteriaFolder ?? "") || action.busy}
            onClick={() => void save({ criteriaFolder: folder.trim() })}
          >
            {t("保存")}
          </button>
        </div>
        <p className="muted">
          {t("判据库是一个放纯文本的文件夹，可以放进 git、在几台机器之间同步。换了位置，旧位置的判据不会自动搬过去。")}
        </p>

        {action.error !== undefined && <div className="error">{action.error}</div>}
        {speechKeyMissing && (
          <div className="notice inline">
            {t("选的朗读连接还没填密钥，▶ 念 会失败。")}{" "}
            <button type="button" className="link" onClick={() => openPage("connections")}>
              {t("去「连接」填密钥")}
            </button>
          </div>
        )}

        {info !== undefined && (
          <>
            <div className="section-title">{t("从 Squad 2.x 导入")}</div>
            <ImportPanel />

            <div className="section-title">{t("关于")}</div>
            <p className="muted">
              {t("Squad {version} · 数据目录 {dir}", { version: info.version, dir: info.dataDir })}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
