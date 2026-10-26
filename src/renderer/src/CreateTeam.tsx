/**
 * CreateTeam.tsx — building a team by picking agents.
 *
 * 移植自 Squad 2.x packages/console/src/client/create.tsx @ 8dcb903
 * 改动：文件夹用系统对话框选（3 是桌面程序）；文案直接写中文。
 *
 * Picking from the library means a seat arrives configured: model,
 * permission mode, ceilings. The typed grammar stays on `/squad-new`, where
 * typing is the point.
 */
import { useState, type JSX } from "react";
import type { AgentWire } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { CreateDesignerTeam } from "./Designer.tsx";
import { BACKEND_LABELS, useLibrary } from "./library.ts";
import { t } from "./locale.ts";

export function CreateTeam(props: {
  readonly onCreated: (teamId: string) => void;
  readonly onOpenLibrary: () => void;
}): JSX.Element {
  const { library, error: loadError } = useLibrary();
  const [displayName, setDisplayName] = useState("");
  const [projectFolder, setProjectFolder] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [secretary, setSecretary] = useState<string | undefined>(undefined);
  const pick = useAction();
  const create = useAction();
  const agents = library?.agents ?? [];

  const choose = async (): Promise<void> => {
    const chosen = await pick.run(() => call("dialog.pickFolder", {}));
    // null is the person cancelling — a choice, not a failure.
    if (chosen?.path !== null && chosen?.path !== undefined) setProjectFolder(chosen.path);
  };

  const toggle = (agent: AgentWire): void => {
    const on = picked.includes(agent.templateId);
    setPicked(on ? picked.filter((id) => id !== agent.templateId) : [...picked, agent.templateId]);
    // Dropping the secretary drops the designation with it: a team submitted
    // with a secretary who is not on it would be refused for a reason the
    // person cannot see from here.
    if (on && secretary === agent.templateId) setSecretary(undefined);
    // Nobody designated yet and this one may be: designate it. The common
    // case has exactly one candidate, and two clicks for it teach nothing.
    if (!on && secretary === undefined && agent.secretaryCandidate) setSecretary(agent.templateId);
  };

  const submit = async (): Promise<void> => {
    const created = await create.run(() =>
      call("teams.create", {
        displayName,
        projectFolder,
        members: picked.map((templateId) => ({
          templateId,
          ...(templateId === secretary ? { isSecretary: true } : {}),
        })),
      }),
    );
    if (created !== undefined) props.onCreated(created.teamId);
  };

  return (
    <div className="form">
      <h2>{t("新建团队")}</h2>
      <label className="field">
        <span>{t("团队名")}</span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder={t("产品评审组")}
        />
      </label>
      <div className="field">
        <span>{t("项目文件夹（席位在这里工作）")}</span>
        <div className="row-gap" style={{ margin: 0 }}>
          <input
            value={projectFolder}
            onChange={(event) => setProjectFolder(event.target.value)}
            placeholder="J:\project\..."
          />
          <button type="button" onClick={() => void choose()} disabled={pick.busy}>
            {t("选择…")}
          </button>
        </div>
        {pick.error !== undefined && <div className="error">{pick.error}</div>}
      </div>

      <div className="field">
        <span>{t("成员（按勾选的顺序发言）")}</span>
        {loadError !== undefined && <div className="error">{loadError}</div>}
        {library !== undefined && agents.length === 0 && (
          <p className="muted">
            {t("Agent 库是空的——先去建一个，这里才有人可选。")}{" "}
            <button type="button" className="link" onClick={props.onOpenLibrary}>
              {t("去 Agent 库")}
            </button>
          </p>
        )}
        {agents.map((agent) => {
          const on = picked.includes(agent.templateId);
          return (
            <div className="pick-row" key={agent.templateId}>
              <label className="check">
                <input type="checkbox" checked={on} onChange={() => toggle(agent)} />
                <span className="dot" style={{ background: agent.color }} />
                <strong>{agent.displayName}</strong>
                <span className="muted">
                  {agent.role} · {BACKEND_LABELS[agent.backend] ?? agent.backend}
                </span>
              </label>
              {/* Chosen among the agents the library cleared for it — an
                  agent whose instructions never mentioned planning should not
                  become the seat that plans because it was the only box. */}
              {!on ? null : agent.secretaryCandidate ? (
                <label className="check">
                  <input
                    type="radio"
                    name="squad-secretary"
                    checked={secretary === agent.templateId}
                    onChange={() => setSecretary(agent.templateId)}
                  />
                  {t("当秘书")}
                </label>
              ) : (
                <span className="muted">{t("不能当秘书")}</span>
              )}
              {on && <span className="muted">#{picked.indexOf(agent.templateId) + 1}</span>}
            </div>
          );
        })}
      </div>
      <p className="muted">
        {t(
          "秘书负责折叠讨论（写上下文检查点）。没指定秘书时，折叠由本机的 Claude Code 来做。建好之后还能从 Agent 库里继续加人。",
        )}
      </p>
      {create.error !== undefined && <div className="error">{create.error}</div>}
      <button
        className="primary"
        type="button"
        onClick={() => void submit()}
        disabled={create.busy || picked.length === 0}
      >
        {t("建团队")}
      </button>
      <hr />
      <CreateDesignerTeam onCreated={props.onCreated} />
    </div>
  );
}
