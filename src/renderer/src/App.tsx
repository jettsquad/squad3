/**
 * App.tsx — the workbench: teams and the libraries on the left, the selected page in the middle.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { TeamSummary } from "../../shared/wire.ts";
import { AgentsPage } from "./AgentsPage.tsx";
import { ArchivePage } from "./ArchivePage.tsx";
import { call, useAction, useTeamChanges } from "./api.ts";
import { BlocksPage } from "./BlocksPage.tsx";
import { ConnectionsPage } from "./ConnectionsPage.tsx";
import { CriteriaPage } from "./CriteriaPage.tsx";
import { CreateTeam } from "./CreateTeam.tsx";
import { useLibrary } from "./library.ts";
import { speech } from "./speech.ts";
import { Startup } from "./Startup.tsx";
import { setLanguage, systemLanguage, t } from "./locale.ts";
import { SettingsPage } from "./SettingsPage.tsx";
import { TeamView } from "./TeamView.tsx";

type Selection =
  | { readonly kind: "team"; readonly teamId: string; readonly note?: string | undefined }
  | { readonly kind: "create" }
  | { readonly kind: "agents" }
  | { readonly kind: "blocks" }
  | { readonly kind: "connections" }
  | { readonly kind: "criteria" }
  | { readonly kind: "settings" }
  | { readonly kind: "archive" }
  | { readonly kind: "none" };

export function App(): JSX.Element {
  const tick = useTeamChanges(undefined);
  const [teams, setTeams] = useState<readonly TeamSummary[]>([]);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const load = useAction();
  const reorder = useAction();
  const openSession = useAction();
  /** groupId → the session last open in that team, so clicking the team returns to it. */
  const lastSession = useRef(new Map<string, string>());
  const { library } = useLibrary();
  // Set before the children render, so every t() below reads the right
  // language; the tree is keyed on it, so a switch redraws everything.
  const lang = library?.settings.language ?? systemLanguage();
  setLanguage(lang);
  // The player owns no settings of its own; it is told whether a speech
  // connection is chosen, and every ▶ on screen follows.
  useEffect(() => {
    speech.configure((library?.settings.speechConnectionId ?? "") !== "");
  }, [library]);

  const refresh = (): Promise<unknown> =>
    load.run(async () => {
      const listed = await call("teams.list", {});
      setTeams(listed.teams);
      setProblems(listed.problems);
    });

  // A control elsewhere asking for a page (e.g. ▶ 念 before read-aloud is set up).
  useEffect(() => {
    const open = (event: Event): void => {
      const kind = (event as CustomEvent<unknown>).detail;
      if (kind === "settings" || kind === "connections") setSelection({ kind });
    };
    window.addEventListener("squad:open-page", open);
    return () => window.removeEventListener("squad:open-page", open);
  }, []);

  // A clicked notification brings its team up.
  useEffect(() => {
    if ((window as Partial<Window>).squad === undefined) return undefined;
    return window.squad.on((name, data) => {
      if (name !== "team.open") return;
      const teamId = (data as { teamId?: unknown }).teamId;
      if (typeof teamId === "string") setSelection({ kind: "team", teamId });
    });
  }, []);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Land on the first team when nothing is chosen yet.
  useEffect(() => {
    if (selection.kind === "none" && teams[0] !== undefined) setSelection({ kind: "team", teamId: teams[0].teamId });
  }, [selection.kind, teams]);

  const current = selection.kind === "team" ? teams.find((team) => team.teamId === selection.teamId) : undefined;
  // The list arrives each team followed by its other sessions; grouped here for the sidebar.
  const groups: TeamSummary[][] = [];
  for (const team of teams) {
    const group = groups.find((one) => one[0]?.groupId === team.groupId);
    if (group === undefined) groups.push([team]);
    else group.push(team);
  }
  const currentGroup = current?.groupId;
  const currentSession = current?.teamId;
  useEffect(() => {
    if (currentGroup !== undefined && currentSession !== undefined)
      lastSession.current.set(currentGroup, currentSession);
  }, [currentGroup, currentSession]);
  const nav = (
    kind: "agents" | "blocks" | "connections" | "criteria" | "settings" | "archive",
    label: string,
  ): JSX.Element => (
    <button
      type="button"
      className={`team-item ${selection.kind === kind ? "selected" : ""}`}
      onClick={() => setSelection({ kind })}
    >
      {label}
    </button>
  );

  return (
    <div className="app" key={lang}>
      <Startup teams={teams} ready={!load.busy} />
      <aside className="sidebar">
        <div className="brand">Squad</div>
        <div className="label">{t("团队")}</div>
        <div className="team-list">
          {groups.map((sessions, index) => {
            const lead = sessions[0];
            if (lead === undefined) return null;
            const open = current?.groupId === lead.groupId;
            return (
              <div key={lead.groupId}>
                <div className={`team-item ${open && sessions.length === 1 ? "selected" : ""} ${open ? "open" : ""}`}>
                  <button
                    type="button"
                    className="team-name"
                    title={lead.displayName}
                    onClick={() => {
                      // Back to the session last open in this team, else its newest.
                      const remembered = lastSession.current.get(lead.groupId);
                      const target = sessions.find((one) => one.teamId === remembered) ?? sessions.at(-1) ?? lead;
                      setSelection({ kind: "team", teamId: target.teamId });
                    }}
                  >
                    <span className={`dot ${sessions.some((one) => one.busy) ? "busy" : ""}`} />
                    <span className="name">{lead.displayName}</span>
                    {sessions.length > 1 && !open && <span className="count">{sessions.length}</span>}
                  </button>
                  {open && groups.length > 1 && (
                    <span className="order">
                      <button
                        type="button"
                        className="link"
                        aria-label={t("上移")}
                        disabled={index === 0}
                        onClick={() => void reorder.run(() => call("teams.move", { teamId: lead.teamId, delta: -1 }))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="link"
                        aria-label={t("下移")}
                        disabled={index === groups.length - 1}
                        onClick={() => void reorder.run(() => call("teams.move", { teamId: lead.teamId, delta: 1 }))}
                      >
                        ↓
                      </button>
                    </span>
                  )}
                </div>
                {open && (
                  <div className="session-list">
                    {sessions.length > 1 &&
                      sessions.map((session) => (
                        <button
                          type="button"
                          key={session.teamId}
                          className={`team-item session ${current?.teamId === session.teamId ? "selected" : ""}`}
                          title={session.sessionLabel}
                          onClick={() => setSelection({ kind: "team", teamId: session.teamId })}
                        >
                          <span className={`dot ${session.busy ? "busy" : ""}`} />
                          <span className="name">{session.sessionLabel}</span>
                        </button>
                      ))}
                    <button
                      type="button"
                      className="team-item session add"
                      disabled={openSession.busy}
                      title={t(
                        "同一队人、同一个项目，另起一段讨论：名册、提示词、资料跟着团队走，讨论记录和用量各算各的",
                      )}
                      onClick={() =>
                        void openSession.run(async () => {
                          const opened = await call("sessions.open", { teamId: lead.teamId });
                          await refresh();
                          setSelection({ kind: "team", teamId: opened.teamId });
                        })
                      }
                    >
                      {t("＋ 新会话")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className={`team-item ${selection.kind === "create" ? "selected" : ""}`}
            onClick={() => setSelection({ kind: "create" })}
          >
            {t("＋ 新建团队")}
          </button>
        </div>
        {nav("archive", t("🗄 归档"))}
        <div className="label">{t("库")}</div>
        {nav("agents", t("Agent 库"))}
        {nav("blocks", t("提示词库"))}
        {nav("connections", t("连接"))}
        {nav("criteria", t("判据库"))}
        {nav("settings", t("设置"))}
        {/* A team that failed to load is said out loud: it and a team that never existed must not look the same. */}
        {problems.map((problem) => (
          <div className="notice" key={problem}>
            {problem}
          </div>
        ))}
        {load.error !== undefined && <div className="notice">{load.error}</div>}
        {reorder.error !== undefined && <div className="notice">{reorder.error}</div>}
        {openSession.error !== undefined && <div className="notice">{openSession.error}</div>}
      </aside>

      {selection.kind === "create" ? (
        <main className="main scroll">
          <CreateTeam
            // The list first: selecting a team the list does not have yet
            // would show nothing until the next change arrives.
            onCreated={(teamId) => void refresh().then(() => setSelection({ kind: "team", teamId }))}
            onOpenLibrary={() => setSelection({ kind: "agents" })}
          />
        </main>
      ) : selection.kind === "agents" ? (
        <AgentsPage />
      ) : selection.kind === "blocks" ? (
        <BlocksPage />
      ) : selection.kind === "connections" ? (
        <ConnectionsPage />
      ) : selection.kind === "criteria" ? (
        <CriteriaPage />
      ) : selection.kind === "archive" ? (
        <ArchivePage onRestored={(teamId) => void refresh().then(() => setSelection({ kind: "team", teamId }))} />
      ) : selection.kind === "settings" ? (
        <SettingsPage />
      ) : current !== undefined ? (
        <TeamView
          key={current.teamId}
          team={current}
          teams={teams}
          onSelect={(teamId, note) => setSelection({ kind: "team", teamId, note })}
          arrivalNote={selection.kind === "team" ? selection.note : undefined}
          onDisbanded={() => void refresh().then(() => setSelection({ kind: "none" }))}
        />
      ) : (
        <main className="main">
          <div className="empty">
            {t("还没有团队。先在「Agent 库」里配好成员，再点左边的「新建团队」。")}
            <p>
              {t("用过 Squad 2.x？")}{" "}
              <button type="button" className="link" onClick={() => setSelection({ kind: "settings" })}>
                {t("把那边的团队和 Agent 导入过来")}
              </button>
            </p>
          </div>
        </main>
      )}
    </div>
  );
}
