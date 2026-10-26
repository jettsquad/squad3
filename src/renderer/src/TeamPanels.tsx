/**
 * TeamPanels.tsx — the team's side panels: materials, the secretary's one-off help, and the audit.
 *
 * 移植自 Squad 2.x packages/console/src/client/{materials,audit}.tsx 与 team-view.tsx 里的秘书协助 @ 8dcb903
 * 改动：文件用系统对话框选（主进程读、解析）；粘贴的截图走 materials.addBytes；
 * 「附上」的勾选放在窗口里，随下一条指令发出（2.x 存在服务端，3 的一个窗口就是全部）。
 */
import { useState, type JSX } from "react";
import { MATERIAL_TOTAL_CHAR_LIMIT } from "../../shared/material.ts";
import type { TeamSummary } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { LocalImage, Markdown } from "./Markdown.tsx";
import { t } from "./locale.ts";

/**
 * What the team holds, and which of it rides along with the next command.
 *
 * Attachment is explicit and visible before you press send — never inferred
 * from the instruction's wording (2.x material.ts). Pinned ones ride along
 * every time, which costs every seat every turn, so pinning is a choice.
 */
export function MaterialsPanel(props: {
  readonly team: TeamSummary;
  readonly attached: readonly string[];
  readonly onToggle: (materialId: string) => void;
}): JSX.Element {
  const { team } = props;
  const action = useAction();
  const [refused, setRefused] = useState<readonly string[]>([]);
  const total = team.materials.reduce((sum, material) => sum + material.chars, 0);

  const pick = async (): Promise<void> => {
    setRefused([]);
    const result = await action.run(() => call("materials.pick", { teamId: team.teamId }));
    if (result !== undefined) setRefused(result.refused);
  };

  return (
    <div className="panel">
      <div className="panel-title">{t("资料")}</div>
      <div className="muted">
        {t(
          "勾上的资料随下一条指令发给所有被点到的席位；📌 常驻的每一轮都带。合计 {used} / {limit} 字。也可以直接把截图粘贴进输入框。",
          { used: total.toLocaleString(), limit: MATERIAL_TOTAL_CHAR_LIMIT.toLocaleString() },
        )}
      </div>
      {team.materials.map((material) => (
        <div className="material" key={material.materialId}>
          <label className="check">
            <input
              type="checkbox"
              checked={material.pinned || props.attached.includes(material.materialId)}
              disabled={material.pinned}
              onChange={() => props.onToggle(material.materialId)}
            />
            <span>{material.name}</span>
          </label>
          <span className="muted">
            {material.imagePath === undefined ? t("{n} 字", { n: material.chars.toLocaleString() }) : t("图片")}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="link"
            title={
              material.pinned ? t("取消常驻：之后只在勾上时带") : t("常驻：之后每一轮都带，每个席位每轮都要读一遍")
            }
            onClick={() =>
              void action.run(() =>
                call("materials.pin", {
                  teamId: team.teamId,
                  materialId: material.materialId,
                  pinned: !material.pinned,
                }),
              )
            }
          >
            {material.pinned ? t("📌 取消常驻") : t("常驻")}
          </button>
          <button
            type="button"
            className="link danger"
            onClick={() => {
              if (!window.confirm(t("移除「{name}」？已经发出的指令带过它的记录还在。", { name: material.name })))
                return;
              void action.run(() => call("materials.remove", { teamId: team.teamId, materialId: material.materialId }));
            }}
          >
            {t("移除")}
          </button>
          {material.imagePath !== undefined && <LocalImage path={material.imagePath} alt={material.name} />}
        </div>
      ))}
      <div className="row-gap">
        <button type="button" onClick={() => void pick()} disabled={action.busy}>
          {action.busy ? t("读取中…") : t("导入文件…")}
        </button>
        <span className="muted">{t("PDF、Word（.docx）、Markdown、纯文本、图片")}</span>
      </div>
      {refused.map((reason) => (
        <div className="error" key={reason}>
          {reason}
        </div>
      ))}
      {action.error !== undefined && <div className="error">{action.error}</div>}
    </div>
  );
}

/**
 * The secretary does one job for the host, off the record. The answer is a
 * DRAFT for the host: not a turn, so nobody's next round inherits it as
 * something the team said (2.x assist.ts).
 */
export function AssistPanel(props: {
  readonly team: TeamSummary;
  readonly onUse: (text: string) => void;
}): JSX.Element {
  const { team } = props;
  const [instruction, setInstruction] = useState("");
  const [answer, setAnswer] = useState<{ text: string; secretary: string } | undefined>(undefined);
  const action = useAction();
  const secretary = team.seats.find((seat) => seat.isSecretary);

  return (
    <div className="panel">
      <div className="panel-title">{t("请秘书帮忙")}</div>
      {secretary === undefined ? (
        <div className="muted">{t("这支团队没有秘书。在上面的成员里指一位，才能请它做总结、列分歧、排分工。")}</div>
      ) : (
        <>
          <div className="muted">
            {t("{name} 只读公开讨论，写一份给你看的草稿——不进讨论记录，不算谁说的话。", {
              name: secretary.displayName,
            })}
          </div>
          <textarea
            rows={2}
            value={instruction}
            placeholder={t("比如：总结到目前为止的分歧，每条写清是谁的观点")}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <div className="row-gap">
            <button
              type="button"
              disabled={action.busy || instruction.trim() === ""}
              onClick={() =>
                void action
                  .run(() => call("secretary.assist", { teamId: team.teamId, instruction }))
                  .then((result) => {
                    if (result !== undefined) setAnswer(result);
                  })
              }
            >
              {action.busy ? t("{name} 在写…", { name: secretary.displayName }) : t("请它写")}
            </button>
          </div>
          {action.error !== undefined && <div className="error">{action.error}</div>}
          {answer !== undefined && (
            <div className="draft">
              <div className="muted">{t("{name} 的草稿（没有进记录）", { name: answer.secretary })}</div>
              <Markdown text={answer.text} projectFolder={team.projectFolder} />
              <div className="row-gap">
                <button type="button" onClick={() => void navigator.clipboard.writeText(answer.text)}>
                  {t("复制")}
                </button>
                <button
                  type="button"
                  onClick={() => props.onUse(answer.text)}
                  title={t("放进输入框，你改过再发给团队")}
                >
                  {t("放进输入框")}
                </button>
                <button type="button" className="link" onClick={() => setAnswer(undefined)}>
                  {t("关掉")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const AUDIT_LABELS: Record<string, string> = {
  "team-created": "建队",
  "team-origin": "建团来源",
  "team-renamed": "改设置",
  "team-disbanded": "归档",
  "seat-added": "加人",
  "seat-removed": "去人",
  "agenda-drafted": "拟草案",
  "agenda-confirmed": "确认议程",
  "agenda-resumed": "续跑",
  "agenda-paused": "议程暂停",
  "agenda-stopped": "议程叫停",
  "agenda-finished": "议程结束",
  "agenda-discarded": "丢弃草案",
  "agenda-rewound": "议程退回",
  "agenda-abandoned": "放弃议程",
  "agenda-decided": "阶段决定",
  "seat-quiet": "安静的命令",
  imported: "导入",
  "material-added": "导入资料",
  "material-removed": "移除资料",
  "checkpoint-folded": "折叠上下文",
  "checkpoint-revoked": "作废检查点",
};

/**
 * What was decided about this team, and when. Separate from the discussion:
 * the transcript is what the team SAID. Collapsed by default — it is read
 * after something has gone wrong.
 */
export function AuditPanel(props: { readonly team: TeamSummary }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const { audit } = props.team;
  if (audit.length === 0) return null;
  return (
    <div className="panel">
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {t("决策记录（{n} 条）", { n: audit.length })}
      </button>
      {open && (
        <div>
          {/* Newest first: what went wrong went wrong recently. */}
          {[...audit].reverse().map((entry) => (
            <div className="audit-row" key={`${entry.at}-${entry.kind}-${entry.detail}`}>
              <span className="muted">{new Date(entry.at).toLocaleString()}</span>
              <span className="pill">{t(AUDIT_LABELS[entry.kind] ?? entry.kind)}</span>
              <span>{entry.detail}</span>
            </div>
          ))}
          <div className="muted">
            {t("讨论的可读副本在项目文件夹的 .squad/discussions/{id}.md，每条指令结束后更新。", {
              id: props.team.teamId,
            })}
          </div>
        </div>
      )}
    </div>
  );
}
