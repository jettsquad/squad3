/**
 * Designer.tsx — the designer team's plan, read and built where it was written.
 *
 * 移植自 Squad 2.x packages/console/src/client/plan-card.tsx @ 8e96d9c
 * 改动：确认时可以逐项改（团队名、每个席位的名字、角色、后端、联网、提示词）——2.x 只能「建出来，再改」，
 * 组队团队设计 §8 把它列为差距；改过的方案在主进程里按同一套规则整份重查，审计里记下原方案和落地方案两个指纹。
 * 另加：组队团队的侧栏（重放组队议程、按种子刷新席位提示词）和新建页上的「建一支组队团队」。
 *
 * Rendered under the reply it came from, for the same reason the agenda draft
 * is: a roster read apart from the discussion that produced it is a roster
 * nobody can judge. The build offer only appears on replies the main process
 * has already parsed and checked, so pressing it cannot fail for a reason
 * that was knowable beforehand — and a reply that looks like a plan but will
 * not build says why, rather than simply having no button.
 */
import { useEffect, useState, type JSX } from "react";
import type { TeamPlan } from "../../shared/team-plan.ts";
import type { MethodOutput, TeamSummary } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { BACKEND_LABELS } from "./library.ts";
import { t } from "./locale.ts";

export type DesignerStatus = MethodOutput<"designer.status">;
export type PlanOffer = DesignerStatus["plans"][number];

/** Is this a designer team, and which secretary replies are plans. Re-read whenever the team changes. */
export function useDesignerStatus(teamId: string, tick: number): DesignerStatus | undefined {
  const [status, setStatus] = useState<DesignerStatus | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void call("designer.status", { teamId }).then(
      (answer) => {
        if (live) setStatus(answer);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [teamId, tick]);
  return status;
}

/**
 * entryId → the plan it carries, fetched once. Module-level because the
 * transcript re-renders on every change, and a plan never changes once said.
 */
const parsed = new Map<string, TeamPlan>();

function usePlan(teamId: string, entryId: string): TeamPlan | undefined {
  const [plan, setPlan] = useState<TeamPlan | undefined>(() => parsed.get(entryId));
  useEffect(() => {
    if (parsed.has(entryId)) {
      setPlan(parsed.get(entryId));
      return;
    }
    let live = true;
    void call("designer.preview", { teamId, entryId }).then(
      ({ plan: answer }) => {
        parsed.set(entryId, answer);
        if (live) setPlan(answer);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [teamId, entryId]);
  return plan;
}

/** A folder box with the system dialog beside it. */
function FolderField(props: { readonly value: string; readonly onChange: (path: string) => void }): JSX.Element {
  const pick = useAction();
  return (
    <>
      <div className="row-gap" style={{ margin: 0 }}>
        <input
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder="J:\project\..."
        />
        <button
          type="button"
          disabled={pick.busy}
          onClick={() =>
            void pick
              .run(() => call("dialog.pickFolder", {}))
              .then((chosen) => {
                // null is the person cancelling — a choice, not a failure.
                if (chosen?.path !== null && chosen?.path !== undefined) props.onChange(chosen.path);
              })
          }
        >
          {t("选择…")}
        </button>
      </div>
      {pick.error !== undefined && <div className="error">{pick.error}</div>}
    </>
  );
}

/**
 * The plan as something a person reads. It arrives as raw JSON because that
 * is what the build needs — and a wall of braces is unreadable at exactly the
 * moment reading matters most. The bytes stay one click away.
 */
export function PlanMessage(props: { readonly teamId: string; readonly entryId: string; readonly raw: string }) {
  const plan = usePlan(props.teamId, props.entryId);
  if (plan === undefined) return <pre className="request">{props.raw}</pre>;
  return (
    <div className="plan">
      <div className="card-title">{plan.teamName}</div>
      <div>{plan.goal}</div>
      <div className="section-title">{t("成员（{n}）", { n: plan.seats.length })}</div>
      <ul className="plan-list">
        {plan.seats.map((seat) => (
          <li key={seat.key}>
            <strong>{seat.displayName}</strong> · {seat.role}
            <span className="muted">
              {` · ${BACKEND_LABELS[seat.backend] ?? seat.backend}`}
              {seat.webAccess === true ? ` · ${t("联网")}` : ""}
              {seat.key === plan.secretaryKey ? ` · ★ ${t("秘书")}` : ""}
            </span>
            <div className="muted">{seat.rationale}</div>
            <details>
              <summary className="muted">{t("它的提示词")}</summary>
              <pre className="request">{seat.systemPrompt}</pre>
            </details>
          </li>
        ))}
      </ul>
      {plan.constraints.length > 0 && (
        <>
          <div className="section-title">{t("约束")}</div>
          <ul className="plan-list">
            {plan.constraints.map((one) => (
              <li key={one}>{one}</li>
            ))}
          </ul>
        </>
      )}
      {plan.risks.length > 0 && (
        <>
          <div className="section-title">{t("红队留下的风险（{n}）", { n: plan.risks.length })}</div>
          <ul className="plan-list">
            {plan.risks.map((one) => (
              <li key={one}>{one}</li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary className="muted">{t("原始 JSON（建团用的就是这一份，除非你在下面改了）")}</summary>
        <pre className="request">{props.raw}</pre>
      </details>
    </div>
  );
}

/** One seat's editable fields. The rest (key, rationale, colour) travel as they were. */
function SeatEditor(props: {
  readonly seat: TeamPlan["seats"][number];
  readonly secretary: boolean;
  readonly onChange: (next: TeamPlan["seats"][number]) => void;
}): JSX.Element {
  const { seat } = props;
  return (
    <div className="draft-card task">
      <div className="row-gap" style={{ margin: 0 }}>
        <input
          value={seat.displayName}
          aria-label={t("名字")}
          onChange={(event) => props.onChange({ ...seat, displayName: event.target.value })}
        />
        <select
          value={seat.backend}
          onChange={(event) =>
            props.onChange({
              ...seat,
              backend: event.target.value as TeamPlan["seats"][number]["backend"],
              // A permission mode belongs to one backend; carried across it would
              // be refused by the check, for a field this form does not show.
              permissionMode: undefined,
            })
          }
        >
          {(["claude-code", "codex", "dsh"] as const).map((backend) => (
            <option key={backend} value={backend}>
              {BACKEND_LABELS[backend] ?? backend}
            </option>
          ))}
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={seat.webAccess === true}
            onChange={(event) => props.onChange({ ...seat, webAccess: event.target.checked })}
          />
          {t("允许联网")}
        </label>
        {props.secretary && <span className="muted">★ {t("秘书")}</span>}
      </div>
      <input
        value={seat.role}
        aria-label={t("角色")}
        onChange={(event) => props.onChange({ ...seat, role: event.target.value })}
      />
      <details>
        <summary className="muted">{t("提示词")}</summary>
        <textarea
          rows={8}
          value={seat.systemPrompt}
          onChange={(event) => props.onChange({ ...seat, systemPrompt: event.target.value })}
        />
      </details>
    </div>
  );
}

/**
 * The build: an empty folder, and — if the host wants — an edit of the plan
 * before anything is written. Untouched is built exactly as the secretary
 * wrote it; an edit is checked whole again in the main process, so a form
 * cannot build what the checks would refuse from a model.
 */
export function PlanCard(props: {
  readonly team: TeamSummary;
  readonly entryId: string;
  readonly onOpenTeam: (teamId: string) => void;
}): JSX.Element {
  const plan = usePlan(props.team.teamId, props.entryId);
  const [open, setOpen] = useState(false);
  const [edited, setEdited] = useState<TeamPlan | undefined>(undefined);
  const [folder, setFolder] = useState("");
  const [built, setBuilt] = useState<MethodOutput<"designer.build"> | undefined>(undefined);
  const action = useAction();

  if (built !== undefined) {
    return (
      <div className="draft-card">
        <strong>{t("已经按这份方案建好了")}</strong>
        <div className="muted">
          {t("Agent 库新增 {n} 个 · 方案指纹 {hash}", { n: built.templateIds.length, hash: built.hash.slice(0, 12) })}
        </div>
        <div className="muted">
          {t("首场议程在新团队那边等你确认。每个 agent 都可以在「Agent 库」里再改——改动会带进用它的团队。")}
        </div>
        <button type="button" className="primary" onClick={() => props.onOpenTeam(built.teamId)}>
          {t("去新团队")}
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="row-gap">
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          {t("按这份方案建团")}
        </button>
        <span className="muted">{t("会在 Agent 库里建出这些成员，再用它们组一支新团队。建之前可以逐项改。")}</span>
      </div>
    );
  }

  const current = edited ?? plan;
  const change = (next: TeamPlan): void => setEdited(next);
  return (
    <div className="draft-card">
      {current === undefined ? (
        <div className="muted">{t("读取方案中…")}</div>
      ) : (
        <>
          <div className="row-gap" style={{ margin: 0 }}>
            <strong>{t("建之前，看一眼、要改就改")}</strong>
            <span style={{ flex: 1 }} />
            {edited !== undefined && (
              <button type="button" className="link" onClick={() => setEdited(undefined)}>
                {t("还原成秘书写的")}
              </button>
            )}
          </div>
          <label className="field">
            <span>{t("团队名")}</span>
            <input
              value={current.teamName}
              onChange={(event) => change({ ...current, teamName: event.target.value })}
            />
          </label>
          {current.seats.map((seat, index) => (
            <SeatEditor
              key={seat.key}
              seat={seat}
              secretary={seat.key === current.secretaryKey}
              onChange={(next) =>
                change({ ...current, seats: current.seats.map((one, at) => (at === index ? next : one)) })
              }
            />
          ))}
          <div className="field">
            {/* An EMPTY folder: a team's folder is its workspace, and the main
                process refuses one another team lives in, by name. */}
            <span>{t("新团队的项目文件夹（要一个还没有团队住的空文件夹）")}</span>
            <FolderField value={folder} onChange={setFolder} />
          </div>
        </>
      )}
      {action.error !== undefined && <div className="error">{action.error}</div>}
      <div className="row-gap">
        <button
          type="button"
          className="primary"
          disabled={action.busy || current === undefined || folder.trim() === ""}
          onClick={() =>
            void action
              .run(() =>
                call("designer.build", {
                  teamId: props.team.teamId,
                  entryId: props.entryId,
                  projectFolder: folder.trim(),
                  ...(edited === undefined ? {} : { plan: edited }),
                }),
              )
              .then((answer) => {
                if (answer !== undefined) setBuilt(answer);
              })
          }
        >
          {action.busy ? t("建团中…") : edited === undefined ? t("确认，建这支团队") : t("按我改过的建")}
        </button>
        <button type="button" disabled={action.busy} onClick={() => setOpen(false)}>
          {t("先不建")}
        </button>
      </div>
    </div>
  );
}

/**
 * A reply that looks like a plan and will not build, and the way to get
 * another. The refusal is shown in full: 「点名了不存在的席位 key」 says exactly
 * what the secretary got wrong, and hiding it would throw that away.
 */
export function PlanRefused(props: { readonly team: TeamSummary; readonly detail: string }): JSX.Element {
  const action = useAction();
  const [sent, setSent] = useState(false);
  return (
    <div className="draft-card">
      <strong>{t("这份方案还不能落地，所以没有建团按钮")}</strong>
      <pre className="request">{props.detail}</pre>
      {action.error !== undefined && <div className="error">{action.error}</div>}
      <div className="row-gap">
        <button
          type="button"
          disabled={action.busy || sent || props.team.busy}
          onClick={() =>
            void action
              .run(() =>
                call("designer.redraft", {
                  teamId: props.team.teamId,
                  note: `上一版被拒收，原因如下，请照着改：\n${props.detail}`,
                }),
              )
              .then((done) => {
                if (done !== undefined) setSent(true);
              })
          }
        >
          {sent ? t("已交给秘书重出") : t("把这些问题发回给秘书，重出一份")}
        </button>
        <span className="muted">{t("它会读上面的讨论，只改这里点到的地方。")}</span>
      </div>
    </div>
  );
}

/**
 * Ask for the plan again, saying what was wrong. It has to be a control rather
 * than a sentence typed at the secretary: that seat is under standing orders
 * never to invent the schema, so 「重出一份」 alone is refused for want of a
 * shape. This carries the shape.
 */
export function RedraftPlan(props: { readonly team: TeamSummary }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const action = useAction();
  if (props.team.busy) return null;
  if (!open) {
    return (
      <div className="row-gap">
        <button type="button" onClick={() => setOpen(true)}>
          {t("方案不对，让秘书重出一份")}
        </button>
        <span className="muted">{t("先在输入框里跟成员说清哪里不对，再点这里收口。")}</span>
      </div>
    );
  }
  return (
    <div className="draft-card">
      <strong>{t("让组队秘书重出一份方案")}</strong>
      <div className="muted">
        {t("它会读上面的整段讨论。这里写本次要改的重点，没点到的部分它会原样保留；留空就按讨论里已经达成的结论重出。")}
      </div>
      <textarea
        rows={3}
        value={note}
        placeholder={t("例如：我要的是团队主笔，成品由席位产出，我只做判断和拍板。")}
        onChange={(event) => setNote(event.target.value)}
      />
      {action.error !== undefined && <div className="error">{action.error}</div>}
      <div className="row-gap">
        <button
          type="button"
          className="primary"
          disabled={action.busy}
          onClick={() =>
            void action
              .run(() => call("designer.redraft", { teamId: props.team.teamId, note }))
              .then((done) => {
                if (done === undefined) return;
                setOpen(false);
                setNote("");
              })
          }
        >
          {t("重出一份")}
        </button>
        <button type="button" disabled={action.busy} onClick={() => setOpen(false)}>
          {t("取消")}
        </button>
      </div>
    </div>
  );
}

/** For a designer team: put the five phases up again, and bring its seats up to the current seed. */
export function DesignerPanel(props: { readonly team: TeamSummary }): JSX.Element {
  const { team } = props;
  const action = useAction();
  const [said, setSaid] = useState<string | undefined>(undefined);
  const idle = !team.busy && team.agenda.running === undefined;
  return (
    <div className="panel">
      <div className="panel-title">{t("组队团队")}</div>
      <div className="muted">{t("这支团队的产物是另一支团队的方案。秘书成稿后，方案下面有建团按钮。")}</div>
      <div className="row-gap">
        <button
          type="button"
          disabled={!idle || action.busy || team.agenda.draft !== undefined}
          title={t("五个阶段每次都一样，不用重打；放上去的仍是草案，要你确认才跑。")}
          onClick={() =>
            void action
              .run(() => call("designer.agenda", { teamId: team.teamId }))
              .then((done) => {
                if (done !== undefined) setSaid(t("组队议程已作为草案放好。"));
              })
          }
        >
          {t("再放一份组队议程")}
        </button>
        <button
          type="button"
          disabled={!idle || action.busy}
          title={t("五个席位的提示词换成这一版程序自带的；模型、连接、权限这些你自己的设置不动。")}
          onClick={() =>
            void action
              .run(() => call("designer.refresh", { teamId: team.teamId }))
              .then((done) => {
                if (done !== undefined) setSaid(t("已更新：{names}", { names: done.refreshed.join("、") }));
              })
          }
        >
          {t("按程序自带的版本刷新席位提示词")}
        </button>
      </div>
      {said !== undefined && <div className="muted">{said}</div>}
      {action.error !== undefined && <div className="error">{action.error}</div>}
    </div>
  );
}

/** On the new-team page: for when the hard part is knowing which seats to have. */
export function CreateDesignerTeam(props: { readonly onCreated: (teamId: string) => void }): JSX.Element {
  const [folder, setFolder] = useState("");
  const action = useAction();
  return (
    <div className="field">
      <span>{t("不知道该配哪些人？")}</span>
      <p className="muted">
        {t(
          "建一支「组队团队」：需求澄清、职能架构、提示词工程、红队、组队秘书五个席位，先问清你的目标，再给出一份可以直接建出来的团队方案。",
        )}
      </p>
      <FolderField value={folder} onChange={setFolder} />
      {action.error !== undefined && <div className="error">{action.error}</div>}
      <div className="row-gap">
        <button
          type="button"
          disabled={action.busy || folder.trim() === ""}
          onClick={() =>
            void action
              .run(() => call("designer.create", { projectFolder: folder.trim() }))
              .then((built) => {
                if (built !== undefined) props.onCreated(built.teamId);
              })
          }
        >
          {t("建组队团队")}
        </button>
        <span className="muted">{t("要一个还没有团队住的空文件夹。")}</span>
      </div>
    </div>
  );
}
