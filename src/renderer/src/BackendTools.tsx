/**
 * BackendTools.tsx — the CLIs seats run on, and the button that upgrades one.
 *
 * 移植自 Squad 2.x packages/console/src/client/backend-tools.tsx @ 8e96d9c
 * 改动：文案走 t()。
 *
 * Next to the agents because that is where a person is when a seat fails for
 * a reason that is not the seat's: an old CLI answers 「model is not
 * supported」 about a model the same account can use from a newer one, and
 * nothing in that message says "upgrade".
 */
import { useEffect, useState, type JSX } from "react";
import type { MethodOutput } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { t } from "./locale.ts";

type ToolStatus = MethodOutput<"tools.list">["tools"][number];
type BackendTool = ToolStatus["tool"];
type UpgradeReport = MethodOutput<"tools.upgrade">;

const NAMES: Readonly<Record<BackendTool, string>> = { "claude-code": "Claude Code", codex: "Codex", dsh: "dsh" };

export function BackendTools(): JSX.Element {
  const [tools, setTools] = useState<readonly ToolStatus[] | undefined>(undefined);
  const check = useAction();
  const upgrade = useAction();
  // Which tool is waiting for the second click. Upgrading replaces a program
  // installed for the whole machine, so it takes two: one to see what would
  // change, one to change it.
  const [confirming, setConfirming] = useState<BackendTool | undefined>(undefined);
  const [upgrading, setUpgrading] = useState<BackendTool | undefined>(undefined);
  const [reports, setReports] = useState<Partial<Record<BackendTool, UpgradeReport>>>({});

  const refresh = (): void => {
    void check.run(async () => setTools((await call("tools.list", {})).tools));
  };
  // Once, when the page opens. Not polled: each look costs three process
  // spawns and three lookups, and a version does not change while you watch.
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (tool: BackendTool): void => {
    setConfirming(undefined);
    setUpgrading(tool);
    void upgrade
      .run(() => call("tools.upgrade", { tool }))
      .then((report) => {
        if (report !== undefined) setReports((current) => ({ ...current, [tool]: report }));
        refresh();
      })
      .finally(() => setUpgrading(undefined));
  };

  return (
    <div className="card">
      <div className="row-gap" style={{ margin: 0 }}>
        <strong>{t("后端工具")}</strong>
        <button type="button" disabled={check.busy || upgrading !== undefined} onClick={refresh}>
          {check.busy ? t("检查中…") : t("检查更新")}
        </button>
      </div>
      {tools?.map((tool) => {
        const report = reports[tool.tool];
        return (
          <div key={tool.tool} className="tool-row">
            <div className="row-gap" style={{ margin: 0 }}>
              <strong>{NAMES[tool.tool]}</strong>
              <span className={tool.outdated ? "badge bad" : "muted"}>
                {tool.installed === undefined
                  ? t("运行不起来")
                  : tool.outdated
                    ? t("{installed} · 有新版 {latest}", { installed: tool.installed, latest: tool.latest ?? "" })
                    : tool.latest === undefined
                      ? tool.installed
                      : t("{installed} · 已是最新", { installed: tool.installed })}
              </span>
              {!tool.canUpgrade ? null : upgrading === tool.tool ? (
                <span className="muted">{t("升级中…可能要一两分钟")}</span>
              ) : confirming === tool.tool ? (
                <>
                  <button type="button" className="primary" onClick={() => run(tool.tool)}>
                    {tool.installed === undefined || tool.latest === undefined
                      ? t("确认重装")
                      : t("确认升级 {installed} → {latest}", { installed: tool.installed, latest: tool.latest })}
                  </button>
                  <button type="button" onClick={() => setConfirming(undefined)}>
                    {t("取消")}
                  </button>
                </>
              ) : (
                <button type="button" disabled={upgrading !== undefined} onClick={() => setConfirming(tool.tool)}>
                  {tool.installed === undefined ? t("重装修复") : t("升级")}
                </button>
              )}
            </div>
            {tool.problem !== undefined && <div className="muted">{tool.problem}</div>}
            {/* The command, shown before it is run: it changes a program
                installed for the whole machine, and a person should be able
                to see exactly what a button is about to do there. */}
            {confirming === tool.tool && tool.upgradeCommand !== undefined && (
              <div className="muted">{t("将在这台电脑上执行：{command}", { command: tool.upgradeCommand })}</div>
            )}
            {report !== undefined &&
              (report.ok ? (
                <div className="muted">
                  {/* The installer ran and the version did not move: its own
                      channel has nothing newer yet. Said as that, not as an
                      upgrade that "completed" from a version to itself. */}
                  {report.before !== undefined && report.before === report.after
                    ? t("安装器跑过了，版本仍是 {version}——它自己的更新通道里还没有更新的版本。", {
                        version: report.after ?? "?",
                      })
                    : t("升级完成：{before} → {after}，已确认能运行。", {
                        before: report.before ?? "?",
                        after: report.after ?? "?",
                      })}
                </div>
              ) : (
                <>
                  <div className="error">{t("升级后运行不起来。下面是安装过程的输出：")}</div>
                  <pre className="request">{report.log}</pre>
                </>
              ))}
          </div>
        );
      })}
      {check.error !== undefined && <div className="error">{check.error}</div>}
      {upgrade.error !== undefined && <div className="error">{upgrade.error}</div>}
    </div>
  );
}
