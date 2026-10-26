/**
 * ImportPanel.tsx — bringing a Squad 2.x home into 3.
 *
 * 3 新增（设计文档 §11）。The dry run comes first and is the default: it
 * shows every team, what will come, what will not and why, and writes
 * nothing. The import is a second, explicit press — and its report is the
 * same list, with each team marked imported or not, and why.
 */
import { useState, type JSX } from "react";
import type { MethodOutput } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { libraryChanged } from "./library.ts";
import { t } from "./locale.ts";

type Report = MethodOutput<"migrate.scan">;
type TeamRow = Report["teams"][number];

const STATUS: Record<TeamRow["status"], { readonly label: string; readonly tone: string }> = {
  importable: { label: "可以导入", tone: "ok" },
  refused: { label: "不导入", tone: "bad" },
  already: { label: "已经在 3 里", tone: "" },
  newer: { label: "2.x 里有新内容，可以补导", tone: "ok" },
  imported: { label: "已导入", tone: "ok" },
  updated: { label: "已补导", tone: "ok" },
  failed: { label: "导入后读不回来", tone: "bad" },
};

export function ImportPanel(): JSX.Element {
  const [home, setHome] = useState("");
  const [report, setReport] = useState<Report | undefined>(undefined);
  const action = useAction();
  // Everything one press would bring: new teams and sessions, sessions 2.x
  // has carried on since, agents and connections not in 3 yet.
  const pending =
    report === undefined || !report.dryRun
      ? 0
      : report.teams.filter((team) => team.status === "importable" || team.status === "newer").length +
        report.agents.filter((agent) => agent.status === "importable").length +
        report.connections.filter((connection) => connection.status === "importable").length;

  const scan = (): void => {
    void action.run(async () => setReport(await call("migrate.scan", home.trim() === "" ? {} : { home: home.trim() })));
  };
  const run = (): void => {
    void action
      .run(async () => setReport(await call("migrate.run", home.trim() === "" ? {} : { home: home.trim() })))
      .then(() => libraryChanged());
  };

  // Shown at the top of the list and again under it, so it is in reach
  // wherever the list was read to.
  const importAll =
    report === undefined || !report.dryRun ? null : pending > 0 ? (
      <div className="row-gap">
        <button type="button" className="primary" disabled={action.busy} onClick={run}>
          {action.busy ? t("正在导入…") : t("全部导入（{n} 项）", { n: pending })}
        </button>
        <span className="muted">{t("只导「可以导入」和「可以补导」的；其余的不动。")}</span>
      </div>
    ) : (
      <p className="muted">{t("没有要导入的：能导的都已经在 3 里了。")}</p>
    );

  return (
    <>
      <div className="row-gap">
        <input value={home} placeholder={t("留空就是 ~/.dsh")} onChange={(event) => setHome(event.target.value)} />
        <button type="button" disabled={action.busy} onClick={scan}>
          {t("看看会导入什么")}
        </button>
      </div>
      <p className="muted">
        {t(
          "只读 2.x 的数据目录，不改它的任何文件。先看一遍会导入什么，再决定导入。一支团队里有任何一处读不懂，这支团队就不导入，别的照常。密钥不带过来，导入后在「连接」里重新填一次。",
        )}
      </p>
      {action.error !== undefined && <div className="error">{action.error}</div>}
      {report !== undefined && (
        <div className="card">
          <strong>{report.dryRun ? t("试运行：什么都还没写") : t("导入完成")}</strong>
          <div className="muted">{report.home}</div>
          {importAll}
          {report.problems.map((problem) => (
            <div className="error" key={problem}>
              {problem}
            </div>
          ))}
          <div className="section-title">{t("团队（{n}）", { n: report.teams.length })}</div>
          {report.teams.map((team) => (
            <div key={team.teamId} className="tool-row">
              <div className="row-gap" style={{ margin: 0 }}>
                <strong>{team.displayName}</strong>
                <span className={`badge ${STATUS[team.status].tone}`}>{t(STATUS[team.status].label)}</span>
                <span className="muted">
                  {t("{lines} 条发言 · {checkpoints} 个检查点", { lines: team.lines, checkpoints: team.checkpoints })}
                </span>
                {team.newLines !== undefined && <span className="muted">{t("新增 {n} 条", { n: team.newLines })}</span>}
              </div>
              <div className="muted">{team.projectFolder}</div>
              {team.problems.map((problem) => (
                <div className="error" key={problem}>
                  {problem}
                </div>
              ))}
              {team.notes.map((note) => (
                <div className="muted" key={note}>
                  · {note}
                </div>
              ))}
            </div>
          ))}
          <div className="section-title">{t("Agent 与连接")}</div>
          {[...report.agents, ...report.connections].map((item) => (
            <div key={item.id} className="row-gap" style={{ margin: "2px 0" }}>
              <span>{item.label}</span>
              <span className="muted">
                {item.status === "already"
                  ? t("已经在 3 里")
                  : item.status === "imported"
                    ? t("已导入")
                    : item.status === "refused"
                      ? t("没导入")
                      : t("可以导入")}
              </span>
              {item.detail !== undefined && <span className="muted">{item.detail}</span>}
            </div>
          ))}
          {report.settings.length > 0 && (
            <>
              <div className="section-title">{t("设置")}</div>
              {report.settings.map((line) => (
                <div key={line} className="muted">
                  {line}
                </div>
              ))}
            </>
          )}
          <div className="section-title">{t("判据库")}</div>
          <div className="muted">
            {report.dryRun
              ? t("{files} 个文件，其中 {already} 个 3 里已经有", {
                  files: report.criteria.files,
                  already: report.criteria.already,
                })
              : t("复制了 {copied} 个文件", { copied: report.criteria.copied })}
          </div>
          {importAll}
        </div>
      )}
    </>
  );
}
