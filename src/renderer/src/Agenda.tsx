/**
 * Agenda.tsx — an agenda in the window: as a seat wrote it, as a draft the
 * host edits and confirms, and as a plan running or waiting for a decision.
 *
 * 移植自 Squad 2.x packages/console/src/client/{agenda-message,draft-card,agenda}.tsx @ 8dcb903
 * 改动：样式换成 3 的类名、文案走 t()；草案的身份（agendaId + revision）随确认一起发；
 * 「由 Lil X 代理」的开关在阶段 4b 接上之前不摆出来——存得下却不起作用的开关不放。
 *
 * Drafting goes through the conversation, as in 2.x: you ask the secretary in
 * the ordinary box, it answers where the team can read and argue, and the
 * 「转成议程」 button on that reply turns the prose into phases. The draft is
 * shown under the reply it came from.
 */
import { useState, type JSX } from "react";
import type { AgendaSpec } from "../../shared/agenda.ts";
import type { AgendaViewWire, DecisionWire, TeamSummary } from "../../shared/wire.ts";
import type { AgendaInText } from "./agenda-text.ts";
import { call, useAction } from "./api.ts";
import { t } from "./locale.ts";
import { Markdown } from "./Markdown.tsx";

type Phase = AgendaSpec["phases"][number];
type NodeView = NonNullable<AgendaViewWire["confirmed"]>["nodes"][number];

const EXIT_LABEL: Record<string, string> = {
  "after-tasks": "跑完任务就结束",
  "after-bounded-rounds": "循环固定轮次",
  "wait-for-host": "停下来等我",
};

/**
 * An agenda a seat wrote, shown as an agenda: braces and `\n` in a long
 * instruction are unreadable at exactly the moment reading matters.
 */
export function AgendaMessage(props: {
  readonly found: AgendaInText;
  readonly seatNames: ReadonlyMap<string, string>;
  readonly projectFolder: string;
}): JSX.Element {
  const { agenda } = props.found;
  return (
    <div>
      {props.found.before !== "" && <Markdown text={props.found.before} projectFolder={props.projectFolder} />}
      {agenda.hostGoal !== undefined && <div className="muted">{t("目标：{goal}", { goal: agenda.hostGoal })}</div>}
      <div className="section-title">{t("议程（{n} 个阶段）", { n: agenda.phases.length })}</div>
      <ol className="plan-list">
        {agenda.phases.map((phase, index) => (
          <li key={`${phase.id ?? index}`}>
            <strong>{phase.title}</strong>
            {phase.purpose !== undefined && <div className="muted">{phase.purpose}</div>}
            <div className="muted">
              {[
                phase.needs === undefined
                  ? undefined
                  : phase.needs.length === 0
                    ? t("不依赖别的阶段")
                    : t("依赖：{ids}", { ids: phase.needs.join("、") }),
                phase.exit === undefined
                  ? undefined
                  : `${t(EXIT_LABEL[phase.exit] ?? "跑完任务就结束")}${phase.maxRounds === undefined ? "" : ` × ${phase.maxRounds}`}`,
                phase.contextMode === "independent" ? t("独立讨论") : undefined,
              ]
                .filter((part): part is string => part !== undefined)
                .join(" · ")}
            </div>
            <ul className="plan-list">
              {phase.tasks.map((task, at) => (
                <li key={`${task.seatId}-${at}`}>
                  <strong>{props.seatNames.get(task.seatId) ?? task.seatId}</strong>
                  <div style={{ whiteSpace: "pre-wrap" }}>{task.instruction}</div>
                  {task.artifactPath !== undefined && (
                    <div className="muted">{t("写入文件：{path}", { path: task.artifactPath })}</div>
                  )}
                </li>
              ))}
            </ul>
            <div className="muted">
              {phase.check === undefined ? (
                t("没有出口检查")
              ) : (
                <>
                  {t("出口检查：")}
                  <code>{phase.check.command}</code>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      {props.found.after !== "" && <Markdown text={props.found.after} projectFolder={props.projectFolder} />}
      <details>
        <summary className="muted">{t("原始 JSON")}</summary>
        <pre className="request">{props.found.json}</pre>
      </details>
    </div>
  );
}

/** One phase, edited in place. */
function PhaseEditor(props: {
  readonly phase: Phase;
  readonly index: number;
  readonly seats: TeamSummary["seats"];
  readonly onChange: (next: Phase) => void;
  readonly onRemove: () => void;
}): JSX.Element {
  const { phase, index, seats } = props;
  const setTask = (at: number, next: Partial<Phase["tasks"][number]>): void =>
    props.onChange({ ...phase, tasks: phase.tasks.map((task, i) => (i === at ? { ...task, ...next } : task)) });
  return (
    <div className="card">
      <div className="row-gap" style={{ margin: 0 }}>
        <span className="muted">{t("阶段 {n}", { n: index + 1 })}</span>
        <input value={phase.title} onChange={(event) => props.onChange({ ...phase, title: event.target.value })} />
        <button type="button" className="link danger" onClick={props.onRemove}>
          {t("删除阶段")}
        </button>
      </div>
      <div className="row-gap">
        <select
          value={phase.contextMode}
          onChange={(event) => props.onChange({ ...phase, contextMode: event.target.value as Phase["contextMode"] })}
        >
          <option value="cumulative">{t("累计讨论")}</option>
          <option value="independent">{t("独立讨论")}</option>
        </select>
        <select
          value={phase.exit ?? "after-tasks"}
          onChange={(event) => {
            const exit = event.target.value as NonNullable<Phase["exit"]>;
            // `maxRounds` only means something for the bounded exit, and the
            // roster check refuses the two apart — so they move together.
            props.onChange({
              ...phase,
              exit,
              ...(exit === "after-bounded-rounds" ? { maxRounds: phase.maxRounds ?? 2 } : { maxRounds: undefined }),
            });
          }}
        >
          {Object.entries(EXIT_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
        {phase.exit === "after-bounded-rounds" && (
          <input
            className="narrow"
            type="number"
            min={1}
            max={20}
            value={phase.maxRounds ?? 2}
            onChange={(event) => props.onChange({ ...phase, maxRounds: Math.max(1, Number(event.target.value) || 1) })}
          />
        )}
      </div>
      {/* The command Squad itself runs to decide whether this phase got done.
          Editable here because this is when the host approves it: it runs with
          their authority, and a phase with no check passes on any reply. */}
      <label className="field">
        <span>
          {t(
            "出口检查（Squad 在项目文件夹里用本机的 shell 运行：Windows 上是 PowerShell，macOS 上是 /bin/sh；退出码 0 才算通过；留空 = 席位答了、且没说未完成就算通过）",
          )}
        </span>
        <input
          className="mono"
          value={phase.check?.command ?? ""}
          placeholder="test -f docs/design.md && npm test"
          onChange={(event) => {
            const command = event.target.value;
            const { check: _dropped, ...rest } = phase;
            props.onChange(command.trim() === "" ? rest : { ...rest, check: { ...phase.check, command } });
          }}
        />
      </label>
      {phase.tasks.map((task, at) => (
        <div key={`${task.seatId}-${at}`} className="task">
          <div className="row-gap" style={{ margin: 0 }}>
            <select value={task.seatId} onChange={(event) => setTask(at, { seatId: event.target.value })}>
              {seats.map((seat) => (
                <option key={seat.seatId} value={seat.seatId}>
                  {seat.displayName}
                </option>
              ))}
              {!seats.some((seat) => seat.seatId === task.seatId) && (
                <option value={task.seatId}>{t("⚠️ 不在名册上：{id}", { id: task.seatId })}</option>
              )}
            </select>
            <button
              type="button"
              className="link danger"
              onClick={() => props.onChange({ ...phase, tasks: phase.tasks.filter((_, i) => i !== at) })}
            >
              {t("删除")}
            </button>
          </div>
          <textarea
            rows={2}
            value={task.instruction}
            onChange={(event) => setTask(at, { instruction: event.target.value })}
          />
          {task.artifactPath !== undefined && (
            <div className="muted">{t("写入文件：{path}", { path: task.artifactPath })}</div>
          )}
        </div>
      ))}
      <button
        type="button"
        className="link"
        onClick={() =>
          props.onChange({ ...phase, tasks: [...phase.tasks, { seatId: seats[0]?.seatId ?? "", instruction: "" }] })
        }
      >
        {t("＋ 加一条任务")}
      </button>
    </div>
  );
}

/**
 * The secretary's draft, where the secretary said it, and EDITABLE: a draft
 * with three phases right and one wrong should not have to be thrown away.
 * The main process re-checks the edit against the roster before running a word.
 */
export function DraftCard(props: { readonly team: TeamSummary }): JSX.Element | null {
  const draft = props.team.agenda.draft;
  // Seeded from the draft and edited locally; the main process keeps the
  // ORIGINAL until the host confirms, so a closed window loses edits, not the draft.
  const [edited, setEdited] = useState<AgendaSpec | undefined>(undefined);
  const [proxy, setProxy] = useState(false);
  const action = useAction();
  if (draft === undefined) return null;
  const agenda = edited ?? draft.agenda;
  const change = (next: AgendaSpec): void => setEdited(next);
  const resolve = (verdict: "confirm" | "discard"): void =>
    void action.run(() =>
      call("agenda.resolve", {
        teamId: props.team.teamId,
        verdict,
        // What this card was showing: a re-draft in the meantime is refused, not run unread.
        agendaId: draft.agendaId,
        revision: draft.revision,
        // The edit travels only when there is one: untouched is confirmed exactly as written.
        ...(verdict === "confirm" && edited !== undefined ? { agenda: edited } : {}),
        ...(verdict === "confirm" && proxy ? { proxy: true } : {}),
      }),
    );
  const empty = agenda.phases.length === 0 || agenda.phases.some((phase) => phase.tasks.length === 0);
  return (
    <div className="draft-card">
      <div className="row-gap" style={{ margin: 0 }}>
        <strong>
          {draft.author === "plan-opening"
            ? t("团队方案里的首场议程 · 第 {n} 版 · 可以改，改完再确认", { n: draft.revision })
            : draft.author === "designer-seed"
              ? t("组队议程（程序自带）· 第 {n} 版 · 可以改，改完再确认", { n: draft.revision })
              : t("秘书的议程草案 · 第 {n} 版 · 可以改，改完再确认", { n: draft.revision })}
        </strong>
        <span style={{ flex: 1 }} />
        {edited !== undefined && (
          <button type="button" className="link" onClick={() => setEdited(undefined)}>
            {t("还原成秘书写的")}
          </button>
        )}
      </div>
      {agenda.hostGoal !== undefined && <div className="muted">{agenda.hostGoal}</div>}
      {draft.problems.map((problem) => (
        <div className="error" key={problem}>
          {problem}
        </div>
      ))}
      {/* Above the phases: this is material for 「按不按这份计划」, and a standard
          shown after the plan reads as a comment on it. Host only — it lives on
          the draft, never in the transcript, so no seat's window carries it. */}
      {draft.criteria.length > 0 && (
        <div className="notice inline">
          {draft.criteria.map((brief, index) => (
            <div key={index}>{brief}</div>
          ))}
        </div>
      )}
      {agenda.phases.map((phase, index) => (
        <PhaseEditor
          key={index}
          phase={phase}
          index={index}
          seats={props.team.seats}
          onChange={(next) => change({ ...agenda, phases: agenda.phases.map((one, i) => (i === index ? next : one)) })}
          onRemove={() => change({ ...agenda, phases: agenda.phases.filter((_, i) => i !== index) })}
        />
      ))}
      <label className="check" style={{ alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={proxy}
          disabled={action.busy}
          onChange={(event) => setProxy(event.target.checked)}
        />
        <span>
          <strong>{t("由 Lil X 代理")}</strong>
          <span className="muted" style={{ display: "block" }}>
            {t(
              "议程自己过不去的地方（出口检查一直不过、席位被别人卡住、席位来问你）不再停下来等你，由 Lil X 替你决定：重做、点别人去清障、回答问题，或者提出方案和相关席位讨论一轮后定案。它不能改你的目标，也不能把没通过的阶段算作通过；同一阶段最多决定 3 次，再不行就放下它、继续做别的。它的每个决定都会写在讨论里。",
            )}
          </span>
        </span>
      </label>
      <div className="row-gap">
        <button type="button" className="primary" disabled={action.busy || empty} onClick={() => resolve("confirm")}>
          {edited === undefined ? t("执行这份议程") : t("按我改过的执行")}
        </button>
        <button type="button" disabled={action.busy} onClick={() => resolve("discard")}>
          {t("丢弃")}
        </button>
        <span className="muted">
          {empty ? t("有阶段一条任务都没有，先补上或者删掉这个阶段。") : t("确认之后才会跑。")}
        </span>
      </div>
      {action.error !== undefined && <div className="error">{action.error}</div>}
    </div>
  );
}

const STATE_LABEL: Record<NodeView["state"], string> = {
  pending: "",
  passed: "✓ 通过",
  deciding: "⚠ 等你决定",
  unresolved: "✗ 已放下",
  skipped: "— 跳过",
};

function checkWords(check: NonNullable<NodeView["lastCheck"]>): string {
  if (check.timedOut === true) return t("超时");
  if (check.exitCode === 0) return t("通过");
  return check.exitCode === null ? t("没能运行或被中止") : t("未通过，退出码 {code}", { code: check.exitCode });
}

/**
 * A node the agenda could not get past, and the four things that can be done.
 * The evidence comes before the buttons: a choice made without it is a guess.
 */
function DecisionCard(props: {
  readonly team: TeamSummary;
  readonly node: NodeView;
  readonly decide: (decision: DecisionWire) => void;
  readonly busy: boolean;
}): JSX.Element {
  const { team, node } = props;
  const [instruction, setInstruction] = useState("");
  const [seatId, setSeatId] = useState(team.seats[0]?.seatId ?? "");
  const said = instruction.trim();
  return (
    <div className="card decision">
      <strong>「{node.title}」</strong>
      {node.why !== undefined && <div className="error">{node.why}</div>}
      {node.check !== undefined && (
        <div className="muted">
          {t("出口检查：")}
          <code>{node.check}</code>
        </div>
      )}
      {node.lastCheck !== undefined && node.lastCheck.tail.trim() !== "" && (
        <details>
          <summary className="muted">{t("检查的输出（{result}）", { result: checkWords(node.lastCheck) })}</summary>
          <pre className="request">{node.lastCheck.tail}</pre>
        </details>
      )}
      <textarea
        rows={2}
        value={instruction}
        placeholder={t("要交代的话（重做时可以不写；让别人清障时必须写清要他做什么）")}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <div className="row-gap">
        <button
          type="button"
          disabled={props.busy}
          onClick={() => props.decide({ kind: "retry", ...(said === "" ? {} : { instruction: said }) })}
        >
          {t("重做")}
        </button>
        <select value={seatId} onChange={(event) => setSeatId(event.target.value)} disabled={props.busy}>
          {team.seats.map((seat) => (
            <option key={seat.seatId} value={seat.seatId}>
              {seat.displayName}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={props.busy || said === "" || seatId === ""}
          title={t("让这位席位先去解决障碍。他做完后，这一阶段自己的席位接着做，出口检查再跑一遍。")}
          onClick={() => props.decide({ kind: "assign", seatId, instruction: said })}
        >
          {t("让他去清障")}
        </button>
      </div>
      <div className="row-gap">
        <button
          type="button"
          className="link"
          disabled={props.busy}
          onClick={() => {
            if (
              window.confirm(
                t("把「{title}」直接算作通过？出口检查不会再跑，后面的阶段会照常开始。", { title: node.title }),
              )
            ) {
              props.decide({ kind: "pass" });
            }
          }}
        >
          {t("视为通过")}
        </button>
        <button
          type="button"
          className="link danger"
          disabled={props.busy}
          onClick={() => {
            if (window.confirm(t("放下「{title}」？依赖它的阶段都会被跳过。", { title: node.title }))) {
              props.decide({ kind: "abandon" });
            }
          }}
        >
          {t("放下它")}
        </button>
      </div>
    </div>
  );
}

/** The agenda that is running, or confirmed and not running: where every node stands, and what can be done. */
export function AgendaPanel(props: { readonly team: TeamSummary }): JSX.Element | null {
  const { team } = props;
  const { confirmed, running, waiting } = team.agenda;
  const action = useAction();
  if (confirmed === undefined && running === undefined && waiting !== true) return null;
  const nodes = confirmed?.nodes ?? [];
  const passed = nodes.filter((node) => node.state === "passed").length;
  const deciding = nodes.filter((node) => node.state === "deciding");
  const dropped = nodes.filter((node) => node.state === "unresolved" || node.state === "skipped").length;
  const next = nodes.find((node) => node.state === "pending")?.title;
  const over = confirmed?.standing === "finished" || confirmed?.standing === "ended";
  const idle = running === undefined && waiting !== true;
  const decide = (nodeId: string, decision: DecisionWire): void =>
    void action.run(() => call("agenda.decide", { teamId: team.teamId, nodeId, decision }));

  return (
    <div className={`panel ${deciding.length > 0 ? "callout" : ""}`}>
      <div className="panel-title">
        {running !== undefined
          ? t("议程进行中")
          : waiting === true
            ? t("议程已确认，等手上的命令答完就开始")
            : deciding.length > 0
              ? t("议程停下来，需要你决定")
              : confirmed?.standing === "finished"
                ? t("议程已经跑完")
                : confirmed?.standing === "ended"
                  ? t("议程结束了，但不是全部通过")
                  : t("有一份议程没跑完")}
      </div>
      {running !== undefined && (
        <div className="muted">
          {t("第 {index} / {count} 阶段：{phase}", {
            index: running.phaseIndex,
            count: running.phaseCount,
            phase: running.phase,
          })}
        </div>
      )}
      {confirmed !== undefined && (
        <div className="muted">
          {t("已通过 {passed} / {total} 个阶段", { passed, total: nodes.length })}
          {dropped === 0 ? "" : ` · ${t("放下或跳过 {n} 个", { n: dropped })}`}
          {` · ${t("确认指纹 {hash}", { hash: confirmed.hash })}`}
        </div>
      )}
      {confirmed?.proxy === true && (
        <div className="muted">
          {t("由 Lil X 代理")}
          {confirmed.reportPath !== undefined && ` · ${t("报告：{path}", { path: confirmed.reportPath })}`}
        </div>
      )}
      {confirmed !== undefined && confirmed.decisions.length > 0 && (
        <details>
          <summary className="muted">{t("Lil X 替你做的决定（{n}）", { n: confirmed.decisions.length })}</summary>
          <ul className="plan-list">
            {confirmed.decisions.map((entry, index) => (
              <li key={index}>
                「{entry.title}」<span className="muted"> {entry.problem}</span>
                <div>{entry.detail}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
      {/* Execution reads the CURRENT roster, on purpose; this keeps that visible. */}
      {confirmed !== undefined && confirmed.drift.length > 0 && (
        <div className="notice inline">
          {t("名册和你确认时不一样了：{drift}。续跑会按现在的名册来。", { drift: confirmed.drift.join("、") })}
        </div>
      )}
      {running !== undefined && (
        <div className="row-gap">
          <button type="button" onClick={() => void action.run(() => call("round.stop", { teamId: team.teamId }))}>
            {t("结束议程")}
          </button>
          <span className="muted">{t("结束会让秘书写一份中止交接，放进项目的 .squad/reports/。")}</span>
        </div>
      )}
      {idle &&
        deciding.map((node) => (
          <DecisionCard
            key={node.nodeId}
            team={team}
            node={node}
            busy={action.busy || team.busy}
            decide={(decision) => decide(node.nodeId, decision)}
          />
        ))}
      {idle && confirmed !== undefined && !over && deciding.length === 0 && (
        <div className="row-gap">
          <button
            type="button"
            className="primary"
            disabled={team.busy || action.busy}
            onClick={() => void action.run(() => call("agenda.resume", { teamId: team.teamId }))}
          >
            {t("从「{next}」继续", { next: next ?? t("下一阶段") })}
          </button>
          <span className="muted">{t("已经通过的阶段不会重跑。")}</span>
        </div>
      )}
      {confirmed !== undefined && (
        <details>
          <summary className="muted">{t("阶段（{n}）· 可以退回到其中任意一个重跑", { n: nodes.length })}</summary>
          <ol className="plan-list">
            {nodes.map((node, index) => (
              <li key={node.nodeId}>
                {node.title} <span className="muted">{t(STATE_LABEL[node.state])}</span>
                {node.attempts > 0 && <span className="muted">{` · ${t("做了 {n} 次", { n: node.attempts })}`}</span>}
                {idle && !(node.state === "pending" && node.attempts === 0) && (
                  <button
                    type="button"
                    className="link"
                    disabled={team.busy}
                    title={t("把议程退回到这一阶段之前。之前说过的话都留着，重跑的席位看得见。")}
                    onClick={() =>
                      void action.run(() => call("agenda.rewind", { teamId: team.teamId, phaseIndex: index }))
                    }
                  >
                    {t("从这里重来")}
                  </button>
                )}
                {/* Passed nodes too: 「主持人判为通过」 and a check that exited 0 are different passes. */}
                {node.why !== undefined && <div className="muted">{node.why}</div>}
                {node.check !== undefined && (
                  <div className="muted">
                    {t("出口检查：")}
                    <code>{node.check}</code>
                    {node.lastCheck === undefined
                      ? t("（还没跑过）")
                      : t("（上次：{result}）", { result: checkWords(node.lastCheck) })}
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className="muted">
            {t(
              "退回只改计划，不删讨论——重跑的席位看得见之前那一版和你反对它的理由。退回之后不会自己开跑，还要你点一次继续。",
            )}
          </div>
        </details>
      )}
      {idle && confirmed !== undefined && (
        <div className="row-gap">
          <button
            type="button"
            className="link"
            disabled={team.busy}
            onClick={() => {
              const asked = over
                ? t("收起这份已经结束的议程？讨论记录不会动。")
                : t("放弃这份议程？还有 {n} 个阶段没通过，放弃后不能再从中间继续。讨论记录不会动。", {
                    n: nodes.length - passed,
                  });
              if (window.confirm(asked)) void action.run(() => call("agenda.abandon", { teamId: team.teamId }));
            }}
          >
            {over ? t("收起这份议程") : t("放弃这份议程")}
          </button>
        </div>
      )}
      {action.error !== undefined && <div className="error">{action.error}</div>}
    </div>
  );
}
