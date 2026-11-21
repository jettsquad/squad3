import { useEffect, useState, type JSX } from "react";
import type { MethodOutput, TeamSummary } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { t } from "./locale.ts";

type Execution = MethodOutput<"cloud.executions">["records"][number];

function ExecutionCard({ record, refresh }: { record: Execution; refresh: () => Promise<void> }): JSX.Element {
  const [note, setNote] = useState("");
  const action = useAction();
  const running = record.state === "running";
  const labels = {
    running: "云端轮次进行中",
    unknown: "本地执行结果待核对",
    completed: "本地已有结果，待核对云端是否收到",
    unreadable: "记录无法读取，待核对",
  };
  return (
    <div className="card">
      <strong>{t(labels[record.state])}</strong>
      <p className="muted">
        {record.project ?? record.id} {record.at > 0 && new Date(record.at).toLocaleString()}
      </p>
      <details>
        <summary>{t("执行证据")}</summary>
        <p>{[record.callId, record.digest].filter(Boolean).join(" · ")}</p>
        {record.exitCode !== undefined && <p>{t("退出码 {code}", { code: record.exitCode })}</p>}
        {record.stdout && <pre className="review-text">{record.stdout}</pre>}
        {record.stderr && <pre className="review-text">{record.stderr}</pre>}
      </details>
      {!running && (
        <>
          <p>{t("请先在工作站核对操作结果。确认后保留核对记录并解除阻止。")}</p>
          <textarea
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
            aria-label={t("核对结论")}
            placeholder={t("核对结论")}
          />
          <button
            type="button"
            disabled={action.busy || note.trim() === ""}
            onClick={() => {
              void action.run(async () => {
                await call("cloud.reconcile", { id: record.id, version: record.version, note });
                await refresh();
              });
            }}
          >
            {t("已核对，解除阻止")}
          </button>
        </>
      )}
      {action.error && <p className="error">{action.error}</p>}
    </div>
  );
}

export function Inbox({ teams, onOpen }: { teams: readonly TeamSummary[]; onOpen: (id: string) => void }): JSX.Element {
  const [{ records, recent }, setExecutions] = useState<MethodOutput<"cloud.executions">>({ records: [], recent: [] });
  const [error, setError] = useState<string>();
  const refresh = async (): Promise<void> => {
    try {
      setExecutions(await call("cloud.executions", {}));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);
  const tasks = teams.flatMap((team) => [
    ...(team.agenda.draft === undefined ? [] : [{ team, key: "draft", label: t("议程草案待确认") }]),
    ...(team.agenda.confirmed?.nodes ?? [])
      .filter((node) => node.state === "deciding")
      .map((node) => ({
        team,
        key: node.nodeId,
        label: `${t("待裁定")} · ${node.title}${node.why ? ` · ${node.why}` : ""}`,
      })),
    ...team.commands
      .filter((entry) => ["queued", "running", "interrupted"].includes(entry.state))
      .map((entry) => ({
        team,
        key: entry.commandId,
        label: `${t(entry.state === "running" ? "运行中" : entry.state === "queued" ? "排队" : "中断待处理")} · ${entry.excerpt}`,
      })),
  ]);
  return (
    <main className="main scroll">
      <div className="page">
        <h2>{t("待处理")}</h2>
        <button type="button" onClick={() => void refresh()}>
          {t("刷新")}
        </button>
        {error && <p className="error">{error}</p>}
        {!error && !tasks.length && !records.length && <p className="muted">{t("当前没有待处理事项。")}</p>}
        {tasks.map(({ team, key, label }) => (
          <div className="list-row" key={team.teamId + ":" + key}>
            <button type="button" className="link" onClick={() => onOpen(team.teamId)}>
              {team.displayName} · {team.sessionLabel}
            </button>
            <span>{label}</span>
          </div>
        ))}
        {records.map((record) => (
          <ExecutionCard key={record.id + record.version} record={record} refresh={refresh} />
        ))}
        {recent.length > 0 && (
          <details className="card">
            <summary>{t("最近核对")}</summary>
            {recent.map((record) => (
              <div key={record.id}>
                <p className="muted">
                  {new Date(record.reviewedAt).toLocaleString()} {record.project}
                </p>
                <p>{record.note}</p>
              </div>
            ))}
          </details>
        )}
      </div>
    </main>
  );
}
