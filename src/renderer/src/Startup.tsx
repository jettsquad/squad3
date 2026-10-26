/**
 * Startup.tsx — what starting up found, said once, over the window.
 *
 * 3 新增（设计文档草图 3：启动画面——找到各后端 CLI、拿到锁、恢复团队）。
 *
 * It stays up only when something matters: a team that did not come back, or
 * a CLI that some team's seats need and that cannot be found. Otherwise it
 * steps aside by itself — a screen that has to be clicked away every morning
 * to say 「everything is fine」 trains people to click it away unread, which
 * is exactly what it must not be on the day something is not.
 */
import { useEffect, useState, type JSX } from "react";
import type { MethodOutput, TeamSummary } from "../../shared/wire.ts";
import { call } from "./api.ts";
import { BACKEND_LABELS } from "./library.ts";
import { t } from "./locale.ts";

type Found = MethodOutput<"app.startup">;

export function Startup(props: {
  readonly teams: readonly TeamSummary[];
  readonly ready: boolean;
}): JSX.Element | null {
  const [found, setFound] = useState<Found | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void call("app.startup", {}).then(setFound, (problem: unknown) =>
      setError(problem instanceof Error ? problem.message : String(problem)),
    );
  }, []);

  const needed = new Set<string>(props.teams.flatMap((team) => team.seats.map((seat) => seat.backend)));
  const blocking =
    found === undefined
      ? []
      : [
          ...found.problems,
          ...found.backends
            .filter((backend) => !backend.found && needed.has(backend.backend))
            .map((backend) =>
              t("{backend} 找不到，而有团队的席位要用它：{detail}", {
                backend: BACKEND_LABELS[backend.backend] ?? backend.backend,
                detail: backend.detail,
              }),
            ),
        ];

  // Fine: step aside once the teams are on screen too.
  useEffect(() => {
    if (found === undefined || !props.ready || blocking.length > 0 || error !== undefined) return undefined;
    const timer = setTimeout(() => setDismissed(true), 900);
    return () => clearTimeout(timer);
  }, [found, props.ready, blocking.length, error]);

  if (dismissed) return null;
  return (
    <div className="startup">
      <div className="startup-card">
        <div className="brand">Squad</div>
        {found === undefined && error === undefined && <div className="muted">{t("正在启动…")}</div>}
        {error !== undefined && <div className="error">{error}</div>}
        {found !== undefined && (
          <ul className="startup-list">
            {found.backends.map((backend) => (
              <li key={backend.backend}>
                <span className={backend.found ? "ok-mark" : "warn-mark"}>{backend.found ? "✓" : "—"}</span>{" "}
                {BACKEND_LABELS[backend.backend] ?? backend.backend}
                <span className="muted">
                  {" "}
                  {backend.found
                    ? t("找到了")
                    : needed.has(backend.backend)
                      ? t("没找到")
                      : t("没找到（现在没有团队用它）")}
                </span>
              </li>
            ))}
            <li>
              <span className="ok-mark">✓</span> {t("只开了这一个 Squad（数据目录已锁定）")}
            </li>
            <li>
              <span className={found.problems.length === 0 ? "ok-mark" : "warn-mark"}>
                {found.problems.length === 0 ? "✓" : "!"}
              </span>{" "}
              {t("恢复了 {n} 支团队", { n: found.teams })}
              {found.problems.length > 0 && (
                <span className="muted"> {t("（{n} 支没能载入）", { n: found.problems.length })}</span>
              )}
            </li>
          </ul>
        )}
        {blocking.map((line) => (
          <div className="notice inline" key={line}>
            {line}
          </div>
        ))}
        {(blocking.length > 0 || error !== undefined) && (
          <button type="button" className="primary" onClick={() => setDismissed(true)}>
            {t("知道了，进去")}
          </button>
        )}
      </div>
    </div>
  );
}
