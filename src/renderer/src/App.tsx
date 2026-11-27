/**
 * App.tsx — the workbench: teams and the libraries on the left, the selected page in the middle.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { TeamSummary } from "../../shared/wire.ts";
import { AgentsPage } from "./AgentsPage.tsx";
import { ArchivePage } from "./ArchivePage.tsx";
import { call, useAction, useTeamChanges } from "./api.ts";
import { BlocksPage } from "./BlocksPage.tsx";
import { ConnectionsPage } from "./ConnectionsPage.tsx";
import { CriteriaPage } from "./CriteriaPage.tsx";
import { CreateTeam } from "./CreateTeam.tsx";
import { libraryChanged, useLibrary } from "./library.ts";
import { speech } from "./speech.ts";
import { Startup } from "./Startup.tsx";
import { setLanguage, systemLanguage, t } from "./locale.ts";
import { SettingsPage } from "./SettingsPage.tsx";
import { TeamView } from "./TeamView.tsx";
import { Inbox } from "./Inbox.tsx";

type Selection =
  | { readonly kind: "team"; readonly teamId: string; readonly note?: string | undefined }
  | { readonly kind: "create" }
  | { readonly kind: "agents" }
  | { readonly kind: "blocks" }
  | { readonly kind: "connections" }
  | { readonly kind: "criteria" }
  | { readonly kind: "settings" }
  | { readonly kind: "archive" }
  | { readonly kind: "inbox" }
  | { readonly kind: "none" };

export function App(): JSX.Element {
  const [leftOpen, setLeftOpen] = useState(() => localStorage.getItem("squad.sidebar.left") !== "closed");
  const [rightOpen, setRightOpen] = useState(() => localStorage.getItem("squad.sidebar.right") !== "closed");
  const tick = useTeamChanges(undefined);
  const [teams, setTeams] = useState<readonly TeamSummary[]>([]);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const load = useAction();
  const reorder = useAction();
  const openSession = useAction();
  /** groupId → the session last open in that team, so clicking the team returns to it. */
  const lastSession = useRef(new Map<string, string>());
  const { library } = useLibrary();
  const [cloudError, setCloudError] = useState<string>();
  useEffect(() => {
    void call("connections.activateCloud", {}).then(
      () => {
        libraryChanged();
      },
      (error: unknown) => {
        setCloudError(error instanceof Error ? error.message : String(error));
      },
    );
  }, []);
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
  const expandGroup = useCallback((groupId: string) => {
    setExpandedGroups((previous) => (previous.has(groupId) ? previous : new Set([...previous, groupId])));
  }, []);
  useEffect(() => {
    if (currentGroup === undefined || currentSession === undefined) return;
    lastSession.current.set(currentGroup, currentSession);
    expandGroup(currentGroup);
  }, [currentGroup, currentSession, expandGroup]);
  const nav = (
    kind: "agents" | "blocks" | "connections" | "criteria" | "settings" | "archive" | "inbox",
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
    <div className={`app ${leftOpen ? "" : "left-collapsed"}`} key={lang}>
      <Startup teams={teams} ready={!load.busy} />
      <div className="sidebar-toolbar">
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={t(leftOpen ? "收起左侧栏" : "展开左侧栏")}
          title={t(leftOpen ? "收起左侧栏" : "展开左侧栏")}
          aria-controls="team-navigation"
          aria-expanded={leftOpen}
          onClick={() => {
            localStorage.setItem("squad.sidebar.left", leftOpen ? "closed" : "open");
            setLeftOpen(!leftOpen);
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
            <path d="M7.5 4v12" />
          </svg>
        </button>
        {current !== undefined && selection.kind === "team" && (
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={t(rightOpen ? "收起右侧栏" : "展开右侧栏")}
            title={t(rightOpen ? "收起右侧栏" : "展开右侧栏")}
            aria-controls="team-details"
            aria-expanded={rightOpen}
            onClick={() => {
              localStorage.setItem("squad.sidebar.right", rightOpen ? "closed" : "open");
              setRightOpen(!rightOpen);
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
              <path d="M12.5 4v12" />
            </svg>
          </button>
        )}
      </div>
      <aside id="team-navigation" className="sidebar" hidden={!leftOpen}>
        <div className="brand">Squad</div>
        <div className="label">{t("团队")}</div>
        <div className="team-list">
          {groups.map((sessions, index) => {
            const lead = sessions[0];
            if (lead === undefined) return null;
            const active = currentGroup === lead.groupId;
            const open = expandedGroups.has(lead.groupId);
            const sessionListId = `team-sessions-${lead.groupId}`;
            const toggleLabel = t(open ? "收起「{name}」的会话" : "展开「{name}」的会话", { name: lead.displayName });
            return (
              <div key={lead.groupId}>
                <div className={`team-item ${active && !open ? "selected" : ""} ${open ? "open" : ""}`}>
                  <button
                    type="button"
                    className="team-name"
                    title={lead.displayName}
                    onClick={() => {
                      expandGroup(lead.groupId);
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
                  {active && open && groups.length > 1 && (
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
                  <button
                    type="button"
                    className="team-expand"
                    aria-controls={sessionListId}
                    aria-expanded={open}
                    aria-label={toggleLabel}
                    title={toggleLabel}
                    onClick={() =>
                      setExpandedGroups((previous) => {
                        const next = new Set(previous);
                        if (next.has(lead.groupId)) next.delete(lead.groupId);
                        else next.add(lead.groupId);
                        return next;
                      })
                    }
                  >
                    <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                  </button>
                </div>
                <div className="session-list" id={sessionListId} hidden={!open}>
                  {sessions.map((session) => (
                    <button
                      type="button"
                      key={session.teamId}
                      className={`team-item session ${current?.teamId === session.teamId ? "selected" : ""}`}
                      aria-current={currentSession === session.teamId ? "true" : undefined}
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
        {nav("inbox", t("待处理"))}
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
      ) : selection.kind === "inbox" ? (
        <Inbox teams={teams} onOpen={(teamId) => setSelection({ kind: "team", teamId })} />
      ) : selection.kind === "blocks" ? (
        <BlocksPage />
      ) : selection.kind === "connections" ? (
        <ConnectionsPage initialCloudError={cloudError} />
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
          detailsOpen={rightOpen}
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
