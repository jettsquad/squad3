/**
 * ArchivePage.tsx — archived teams and sessions: restore them, or delete them for good.
 *
 * 3 新写的（2.x 解散之后没有入口找回）。归档是可逆的一步；删除只在这里，所以永远是两步，
 * 并且先问一句。删的是 Squad 自己数据目录里的那份；项目文件夹里的东西不碰。
 */
import { useEffect, useState, type JSX } from "react";
import type { MethodOutput } from "../../shared/wire.ts";
import { call, useAction, useTeamChanges } from "./api.ts";
import { t } from "./locale.ts";

type Archive = MethodOutput<"archive.list">;

const when = (at: number): string => new Date(at).toLocaleString();

export function ArchivePage(props: { readonly onRestored: (teamId: string) => void }): JSX.Element {
  const tick = useTeamChanges(undefined);
  const [archive, setArchive] = useState<Archive | undefined>(undefined);
  const load = useAction();
  const act = useAction();

  useEffect(() => {
    void load.run(async () => setArchive(await call("archive.list", {})));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const restore = (teamId: string): void => {
    void act.run(async () => {
      const back = await call("archive.restore", { teamId });
      props.onRestored(back.teamId);
    });
  };
  const remove = (teamId: string, question: string): void => {
    if (!window.confirm(question)) return;
    void act.run(async () => {
      await call("archive.delete", { teamId });
      setArchive(await call("archive.list", {}));
    });
  };

  const empty = archive !== undefined && archive.teams.length === 0 && archive.sessions.length === 0;
  return (
    <main className="main scroll">
      <div className="page">
        <h2>{t("归档")}</h2>
        <p className="muted">
          {t("归档的团队和会话不在左栏里，记录还在磁盘上。恢复就回到左栏，接着用；删除是永久的，找不回来。")}
        </p>
        {load.error !== undefined && <div className="error">{load.error}</div>}
        {act.error !== undefined && <div className="error">{act.error}</div>}
        {empty && <p className="muted">{t("没有归档的团队或会话。")}</p>}

        {archive !== undefined && archive.teams.length > 0 && (
          <>
            <div className="section-title">{t("团队")}</div>
            {archive.teams.map((team) => (
              <div className="card" key={team.teamId}>
                <div className="card-title">{team.displayName}</div>
                <div className="muted">
                  {team.projectFolder} · {t("归档于 {at}", { at: when(team.archivedAt) })}
                </div>
                {team.sessions.length > 1 && (
                  <ul className="plan-list">
                    {team.sessions.map((session) => (
                      <li key={session.teamId}>{session.label}</li>
                    ))}
                  </ul>
                )}
                <div className="row-gap">
                  <button type="button" disabled={act.busy} onClick={() => restore(team.teamId)}>
                    {t("恢复")}
                  </button>
                  <button
                    type="button"
                    className="link danger"
                    disabled={act.busy}
                    onClick={() =>
                      remove(
                        team.teamId,
                        team.sessions.length > 1
                          ? t(
                              "永久删除「{name}」和它的 {n} 场会话？讨论记录、用量、议程都会删掉，找不回来。项目文件夹里的文件不受影响。",
                              {
                                name: team.displayName,
                                n: team.sessions.length,
                              },
                            )
                          : t(
                              "永久删除「{name}」？讨论记录、用量、议程都会删掉，找不回来。项目文件夹里的文件不受影响。",
                              {
                                name: team.displayName,
                              },
                            ),
                      )
                    }
                  >
                    {t("永久删除")}
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        {archive !== undefined && archive.sessions.length > 0 && (
          <>
            <div className="section-title">{t("会话（团队还在用）")}</div>
            {archive.sessions.map((session) => (
              <div className="list-row" key={session.teamId}>
                <span>
                  {session.teamName} · {session.label}
                </span>
                <span className="muted">{t("归档于 {at}", { at: when(session.archivedAt) })}</span>
                <span className="row-gap">
                  <button type="button" disabled={act.busy} onClick={() => restore(session.teamId)}>
                    {t("恢复")}
                  </button>
                  <button
                    type="button"
                    className="link danger"
                    disabled={act.busy}
                    onClick={() =>
                      remove(
                        session.teamId,
                        t(
                          "永久删除「{name}」的「{label}」？这一场的讨论记录和用量会删掉，找不回来。团队和别的场次不受影响。",
                          {
                            name: session.teamName,
                            label: session.label,
                          },
                        ),
                      )
                    }
                  >
                    {t("永久删除")}
                  </button>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </main>
  );
}
