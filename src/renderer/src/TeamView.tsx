/**
 * TeamView.tsx — one team: who is at the table, what was said, and the box you type into.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { applyMention, mentionCandidates, mentionDraftAt, type MentionDraft } from "../../shared/mention.ts";
import type { SeatSummary, TeamSummary, TranscriptLine } from "../../shared/wire.ts";
import { call, useAction, useTeamChanges } from "./api.ts";
import { ContextPanel } from "./ContextPanel.tsx";
import { AgendaMessage, AgendaPanel, DraftCard } from "./Agenda.tsx";
import { agendaInText } from "./agenda-text.ts";
import { defaultVoiceFor } from "../../shared/voices.ts";
import { Dictate, SpeakButton } from "./Voice.tsx";
import { useLibrary } from "./library.ts";
import {
  DesignerPanel,
  PlanCard,
  PlanMessage,
  PlanRefused,
  RedraftPlan,
  useDesignerStatus,
  type PlanOffer,
} from "./Designer.tsx";
import { Markdown } from "./Markdown.tsx";
import { SeatEditor } from "./SeatEditor.tsx";
import { AssistPanel, AuditPanel, MaterialsPanel } from "./TeamPanels.tsx";
import { TeamPromptsPanel } from "./TeamPrompts.tsx";
import { slashCandidates } from "../../shared/slash.ts";
import { runSlash } from "./slash.ts";
import { t } from "./locale.ts";

function seconds(ms: number | undefined): string {
  return ms === undefined ? "" : t("{n} 秒", { n: (ms / 1000).toFixed(1) });
}

function usageText(line: TranscriptLine): string {
  const usage = line.usage;
  if (usage === undefined) return "";
  const parts = [t("入 {n}", { n: usage.inputTokens }), t("出 {n}", { n: usage.outputTokens })];
  if (usage.cacheReadTokens > 0) parts.push(t("缓存读 {n}", { n: usage.cacheReadTokens }));
  if (usage.cacheCreationTokens > 0) parts.push(t("建缓存 {n}", { n: usage.cacheCreationTokens }));
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.join(" · ");
}

/** How long a turn has run, read at a glance: 「不到 1 分钟」「12 分钟」「1 小时 5 分」. */
export function elapsedText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t("不到 1 分钟");
  if (minutes < 60) return t("{n} 分钟", { n: minutes });
  return t("{h} 小时 {m} 分", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** 「已跑 12 分钟 · 8 个子 Agent 在跑」: what makes a long wordless turn readable. */
function runningText(seat: SeatSummary, now: number): string {
  const parts: string[] = [];
  if (seat.startedAt !== undefined) parts.push(t("已跑 {time}", { time: elapsedText(now - seat.startedAt) }));
  if (seat.subagents > 0) parts.push(t("{n} 个子 Agent 在跑", { n: seat.subagents }));
  return parts.join(" · ");
}

/** What a seat is doing, in a few words. "待命" is a state, not the absence of one (2.x §16.3). */
function seatStatus(seat: SeatSummary, now: number = Date.now()): string {
  const running = runningText(seat, now);
  const head = running === "" ? t("工作中") : `${t("工作中")} · ${running}`;
  if (seat.working && seat.doing !== undefined) return `${head} · ${seat.doing}`;
  if (seat.working) return `${head} · ${t("已收到 {n} 字", { n: seat.received })}`;
  if (seat.queued > 0) return t("排队 {n} 条", { n: seat.queued });
  return seat.continuing ? t("待命 · 续接会话") : t("待命");
}

/**
 * The team in one sentence: who is doing what, or that it is idle (2.x
 * team-view.tsx `statusLine`). The agenda's stage joins this in phase 4.
 */
function statusLine(team: TeamSummary, now: number = Date.now()): string {
  const working = team.seats.filter((seat) => seat.working);
  if (working.length > 0) {
    return working
      .map((seat) => {
        const said =
          seat.doing === undefined
            ? t("{name}在答", { name: seat.displayName })
            : t("{name}在{doing}", { name: seat.displayName, doing: seat.doing });
        const running = runningText(seat, now);
        return running === "" ? said : `${said}（${running}）`;
      })
      .join(t("；"));
  }
  if (team.busy) return t("准备中（新开会话前先折叠）");
  const queued = team.commands.filter((command) => command.state === "queued").length;
  return queued > 0 ? t("{n} 条指令在排队", { n: queued }) : t("空闲");
}

/** What one seat was handed for one command, straight from the log. */
function SeatRequest(props: { readonly teamId: string; readonly line: TranscriptLine }): JSX.Element {
  const [prompt, setPrompt] = useState<string | undefined>(undefined);
  const action = useAction();
  const open = prompt !== undefined;
  const toggle = async (): Promise<void> => {
    if (open) {
      setPrompt(undefined);
      return;
    }
    const { seatId, commandId } = props.line;
    if (seatId === undefined || commandId === undefined) return;
    const request = await action.run(() => call("teams.seatRequest", { teamId: props.teamId, commandId, seatId }));
    if (request !== undefined) setPrompt(request.prompt);
  };
  return (
    <>
      <button className="link" type="button" onClick={() => void toggle()}>
        {open ? t("收起") : t("看它这一轮拿到了什么")}
      </button>
      {action.error !== undefined && <div className="error">{action.error}</div>}
      {open && <div className="request">{prompt}</div>}
    </>
  );
}

/**
 * One line of the discussion. Memoised: typing in the box redraws the team
 * page, and redrawing every line with it is what made each keystroke take
 * half a second on a long discussion (2026-10-24). Every prop is stable
 * between keystrokes — the callbacks included.
 */
const Line = memo(function Line(props: {
  readonly teamId: string;
  readonly line: TranscriptLine;
  readonly projectFolder: string;
  /** The speaker's seat colour, so who spoke reads at a glance. */
  readonly color?: string | undefined;
  readonly quoted: boolean;
  readonly onQuote: (entryId: string) => void;
  readonly team: TeamSummary;
  /** When this is a secretary reply that looks like a team plan: buildable, or refused with why. */
  readonly planOffer?: PlanOffer | undefined;
  readonly onOpenTeam: (teamId: string) => void;
}): JSX.Element {
  const { line, team, planOffer } = props;
  const toAgenda = useAction();
  const mark = useAction();
  const [marked, setMarked] = useState<string | undefined>(undefined);
  const secretary = team.seats.find((seat) => seat.isSecretary);
  // Only on the SECRETARY's own completed reply: converting another member's
  // would let that member schedule the team under the secretary's name.
  const convertible =
    line.kind === "seat" &&
    secretary !== undefined &&
    line.seatId === secretary.seatId &&
    line.failed !== true &&
    line.cancelled !== true &&
    // A team plan is built, not scheduled: its own card is below it.
    planOffer === undefined;
  const agendaShown = line.kind === "seat" ? agendaInText(line.text) : undefined;
  if (line.kind === "checkpoint") {
    return (
      <div className={`msg checkpoint ${line.revoked === true ? "revoked" : ""}`}>
        <div className="who">
          <strong>{t("上下文检查点")}</strong>
          <span>{line.revoked === true ? t("已作废：被折叠的原文重新进入上下文") : t("此前的讨论由它代替")}</span>
          <span>{new Date(line.at).toLocaleTimeString()}</span>
        </div>
        <details>
          <summary className="muted">{t("展开要点")}</summary>
          <Markdown text={line.text} />
        </details>
      </div>
    );
  }
  return (
    <div
      className={`msg ${line.kind} ${line.failed === true && line.cancelled !== true ? "failed" : ""} ${props.quoted ? "quoted" : ""}`}
      style={props.color === undefined ? undefined : { borderLeftColor: props.color }}
    >
      <div className="who">
        <strong style={props.color === undefined ? undefined : { color: props.color }}>{line.speaker}</strong>
        {line.kind === "seat" && line.cancelled === true && <span>{t("被叫停")}</span>}
        {line.kind === "seat" && line.failed === true && line.cancelled !== true && <span>{t("失败")}</span>}
        {line.kind === "seat" && line.contextLines !== undefined && (
          <span>{t("带了 {n} 行讨论", { n: line.contextLines })}</span>
        )}
        {/* 0 is "not recorded" (an import from 2.x keeps no durations), never a real turn. */}
        {line.kind === "seat" && (line.durationMs ?? 0) > 0 && <span>{seconds(line.durationMs)}</span>}
        {line.kind === "seat" && <span>{usageText(line)}</span>}
        {line.kind === "seat" && line.failed !== true && line.text.trim() !== "" && (
          <SpeakButton
            entryId={line.entryId}
            speaker={line.speaker}
            text={line.text}
            voiceId={team.seats.find((seat) => seat.seatId === line.seatId)?.voiceId ?? defaultVoiceFor(line.speaker)}
          />
        )}
        <span>{new Date(line.at).toLocaleTimeString()}</span>
        {line.kind !== "system" && (
          // Pointed at for the next command: ADDITIVE on top of what each
          // seat already carries (2.x quotes.ts).
          <button type="button" className="link" onClick={() => props.onQuote(line.entryId)}>
            {props.quoted ? t("取消引用") : t("引用")}
          </button>
        )}
        {/* Says what it read, not just that it worked: a capture that silently
            read the wrong window is a criterion you cannot account for later. */}
        {line.kind === "host" && line.sentFor !== undefined && (
          <span className="pill" title={t("程序替你发给秘书的请求，措辞写在程序里——不算你说的话")}>
            {t("程序代发")}
          </span>
        )}
        {line.kind === "host" && line.agendaPhase === undefined && line.sentFor === undefined && (
          <button
            type="button"
            className="link"
            disabled={mark.busy}
            title={t("我这句话里有一条我的标准——连同上一次我说话之后各席位的答复一起，蒸馏成一条待裁定的判据")}
            onClick={() =>
              void mark
                .run(() => call("criteria.mark", { teamId: props.teamId, entryId: line.entryId }))
                .then((result) => {
                  if (result === undefined) return;
                  setMarked(
                    result.from.length === 0
                      ? t("这一轮没有席位发言，只从你这句话提炼。已放进待裁定。")
                      : t("读了 {names} 的答复，已放进待裁定。到「判据库」去裁。", { names: result.from.join("、") }),
                  );
                })
            }
          >
            {mark.busy ? t("提炼中…") : marked !== undefined ? t("已记下 ✓") : t("记下来")}
          </button>
        )}
      </div>
      {line.kind === "system" ? (
        <div className="body">{line.text}</div>
      ) : planOffer?.ok === true ? (
        <PlanMessage teamId={team.teamId} entryId={line.entryId} raw={line.text} />
      ) : agendaShown !== undefined ? (
        <AgendaMessage
          found={agendaShown}
          seatNames={new Map(team.seats.map((seat) => [seat.seatId, seat.displayName]))}
          projectFolder={props.projectFolder}
        />
      ) : (
        <Markdown text={line.text} projectFolder={props.projectFolder} />
      )}
      {marked !== undefined && <div className="muted">{marked}</div>}
      {mark.error !== undefined && <div className="error">{mark.error}</div>}
      {/* Only when a request was recorded: a seat stopped by its cap, or one
          that failed before starting, was handed nothing to show. */}
      {line.kind === "seat" && line.contextLines !== undefined && <SeatRequest teamId={props.teamId} line={line} />}
      {convertible && (
        <div>
          <button
            type="button"
            className="link"
            disabled={toAgenda.busy || team.busy}
            title={t("请秘书把这段安排写成可以确认、可以执行的议程。确认之前什么都不会跑。")}
            onClick={() =>
              void toAgenda.run(() => call("agenda.fromReply", { teamId: props.teamId, entryId: line.entryId }))
            }
          >
            {toAgenda.busy ? t("秘书在排议程…") : t("转成议程")}
          </button>
          {toAgenda.error !== undefined && <div className="error">{toAgenda.error}</div>}
        </div>
      )}
      {planOffer?.ok === true && <PlanCard team={team} entryId={line.entryId} onOpenTeam={props.onOpenTeam} />}
      {planOffer?.ok === false && <PlanRefused team={team} detail={planOffer.detail} />}
      {/* Under the reply it came from: a plan read apart from its reasoning is a plan nobody can judge. */}
      {team.agenda.draft?.fromEntryId === line.entryId && <DraftCard team={team} />}
    </div>
  );
});

/** Name this session, or put it away. Shown only when the team has more than one. */
function SessionActions(props: { readonly team: TeamSummary; readonly onClosed: () => void }): JSX.Element {
  const { team } = props;
  const [naming, setNaming] = useState<string | undefined>(undefined);
  const action = useAction();
  return (
    <div className="row-gap session-actions">
      {naming === undefined ? (
        <>
          <button type="button" className="link" onClick={() => setNaming(team.sessionName ?? "")}>
            {t("给这场起名")}
          </button>
          <button
            type="button"
            className="link danger"
            disabled={action.busy || team.busy}
            title={t("这场会从列表里拿下，记录留在磁盘上，可以在「归档」里恢复；团队和别的场次不受影响")}
            onClick={() =>
              void action.run(async () => {
                await call("sessions.close", { teamId: team.teamId });
                props.onClosed();
              })
            }
          >
            {t("归档这场")}
          </button>
        </>
      ) : (
        <>
          <input
            value={naming}
            autoFocus
            placeholder={t("留空就叫「第 N 场 · 时间」")}
            onChange={(event) => setNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setNaming(undefined);
            }}
          />
          <button
            type="button"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await call("sessions.rename", { teamId: team.teamId, name: naming });
                setNaming(undefined);
              })
            }
          >
            {t("保存")}
          </button>
          <button type="button" className="link" onClick={() => setNaming(undefined)}>
            {t("取消")}
          </button>
        </>
      )}
      {action.error !== undefined && <span className="error inline">{action.error}</span>}
    </div>
  );
}

export function TeamView(props: {
  readonly team: TeamSummary;
  readonly teams: readonly TeamSummary[];
  /** Switch teams; `note` is shown on arrival (a slash command's answer about the team it switched to). */
  readonly onSelect: (teamId: string, note?: string) => void;
  /** Shown when this view opens: what the command that brought us here said. */
  readonly arrivalNote?: string | undefined;
  readonly onDisbanded: () => void;
}): JSX.Element {
  const { team } = props;
  const [shown, setShown] = useState<string | undefined>(props.arrivalNote);
  // A seat deep in tools can go an hour without changing anything else on
  // screen; the elapsed time is redrawn on its own while anyone is working.
  const [now, setNow] = useState(() => Date.now());
  const anyWorking = team.seats.some((seat) => seat.working);
  useEffect(() => {
    if (!anyWorking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [anyWorking]);
  const tick = useTeamChanges(team.teamId);
  const { library } = useLibrary();
  const designer = useDesignerStatus(team.teamId, tick);
  /** The newest page, re-read on every change. */
  const [recent, setRecent] = useState<readonly TranscriptLine[]>([]);
  /** Pages brought back with 「更早的」, older than `recent`. Kept across re-reads. */
  const [older, setOlder] = useState<readonly TranscriptLine[]>([]);
  /** How many lines are still before the first one on screen. */
  const [earlier, setEarlier] = useState(0);
  /** Lines pointed at for the next command, by entry id. */
  const [quoteIds, setQuoteIds] = useState<readonly string[]>([]);
  /** Documents attached to the next command. Pinned ones ride along without being listed. */
  const [attached, setAttached] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState("");
  const [mention, setMention] = useState<MentionDraft | undefined>(undefined);
  const load = useAction();
  const send = useAction();
  const control = useAction();
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const names = team.seats.map((seat) => seat.displayName);
  const candidates = mention === undefined ? [] : mentionCandidates(mention, names);

  useEffect(() => {
    void load.run(async () => {
      // With earlier pages on screen, the newest page must still reach back to
      // them, or lines arriving now would open a hole between the two.
      const page = await call("teams.transcript", {
        teamId: team.teamId,
        ...(older.length === 0 ? {} : { limit: Math.min(500, recent.length + 150) }),
      });
      setRecent(page.lines);
      const first = page.lines[0]?.seq;
      // The older pages already on screen stay, minus anything the new page now covers.
      setOlder((current) => (first === undefined ? current : current.filter((line) => line.seq < first)));
      // With earlier pages on screen, what is left before them does not change when new lines arrive.
      setEarlier((current) => (older.length === 0 ? page.earlier : current));
    });
    // `load` is a fresh object each render; re-reading on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.teamId, tick]);

  // The same array until lines actually arrive: what lets every line skip a
  // redraw while the person types.
  const lines = useMemo(() => [...older, ...recent], [older, recent]);
  const lastSeq = recent.at(-1)?.seq;
  useEffect(() => {
    // Only when something new arrived at the END: bringing back an earlier
    // page must not throw the reader to the bottom.
    // A block body: since Chromium 152 `scrollIntoView()` returns a Promise,
    // and an expression-bodied effect would hand it to React as a cleanup.
    void bottom.current?.scrollIntoView({ block: "end" });
  }, [lastSeq]);

  /** Where the reader is: whether there is anything above or below to jump to. */
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ atTop: true, atBottom: true });
  const measure = (): void => {
    const el = scroller.current;
    if (el === null) return;
    setEdges({ atTop: el.scrollTop < 4, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 4 });
  };
  useEffect(measure, [lines.length]);

  /** To the very first line of the discussion: every earlier page is brought in first, not just the top of what is loaded. */
  const toTop = async (): Promise<void> => {
    let first = lines[0]?.seq;
    let left = earlier;
    const gathered: TranscriptLine[] = [];
    const done = await load.run(async () => {
      while (left > 0 && first !== undefined) {
        const page = await call("teams.transcript", { teamId: team.teamId, beforeSeq: first, limit: 500 });
        if (page.lines.length === 0) break;
        gathered.unshift(...page.lines);
        left = page.earlier;
        first = page.lines[0]?.seq;
      }
      return true;
    });
    if (done === undefined) return;
    if (gathered.length > 0) {
      setOlder((current) => [...gathered, ...current]);
      setEarlier(left);
    }
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: 0 }));
  };
  const toBottom = (): void => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  };

  const loadEarlier = async (): Promise<void> => {
    const first = lines[0]?.seq;
    if (first === undefined) return;
    const page = await load.run(() => call("teams.transcript", { teamId: team.teamId, beforeSeq: first }));
    if (page === undefined) return;
    setOlder((current) => [...page.lines, ...current]);
    setEarlier(page.earlier);
  };

  const colorOf = new Map(team.seats.map((seat) => [seat.displayName, seat.color]));
  const quotedLines = lines.filter((line) => quoteIds.includes(line.entryId));
  // Stable across renders, so a memoised line is not redrawn for a new function.
  const toggleQuote = useCallback(
    (entryId: string): void =>
      setQuoteIds((current) =>
        current.includes(entryId) ? current.filter((id) => id !== entryId) : [...current, entryId],
      ),
    [],
  );
  const selectRef = useRef(props.onSelect);
  useEffect(() => {
    selectRef.current = props.onSelect;
  }, [props.onSelect]);
  const openTeam = useCallback((teamId: string): void => selectRef.current(teamId), []);
  const toggleAttached = (materialId: string): void =>
    setAttached((current) =>
      current.includes(materialId) ? current.filter((id) => id !== materialId) : [...current, materialId],
    );
  // A document removed elsewhere drops out of the selection rather than refusing the next send.
  const attachedHeld = attached.filter((id) => team.materials.some((material) => material.materialId === id));

  /**
   * A screenshot pasted into the box becomes a team material, attached to the
   * next command. The clipboard has no path, so the bytes travel.
   */
  const paste = async (files: readonly File[]): Promise<void> => {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let at = 0; at < bytes.length; at += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
      const added = await send.run(() =>
        call("materials.addBytes", {
          teamId: team.teamId,
          name: file.name === "" ? "image.png" : file.name,
          base64: btoa(binary),
        }),
      );
      if (added !== undefined) setAttached((current) => [...current, added.materialId]);
    }
  };

  const submit = async (): Promise<void> => {
    const text = draft;
    if (text.trim() === "") return;
    // Cleared on press, put back on refusal: a sentence left in the box while
    // its command runs looks unsent, and gets sent twice (2.x §10.3).
    setDraft("");
    setMention(undefined);
    const sent = await send.run(async () => {
      // A slash command is the host operating the table: run here, shown
      // here, never recorded as something anyone said.
      const outcome = await runSlash(text, team, props.teams);
      if (outcome === undefined) {
        const sent = await call("round.say", {
          teamId: team.teamId,
          text,
          ...(quoteIds.length === 0 ? {} : { quoteIds: [...quoteIds] }),
          ...(attachedHeld.length === 0 ? {} : { materialIds: attachedHeld }),
        });
        // Used up by this command; the next one starts with nothing pointed at.
        setQuoteIds([]);
        setAttached([]);
        return sent;
      }
      // Carried across a switch: this view unmounts, and an answer set here
      // (the risks a built plan left) would vanish with it.
      if (outcome.select !== undefined && outcome.select !== team.teamId) props.onSelect(outcome.select, outcome.show);
      else setShown(outcome.show);
      return outcome;
    });
    if (sent === undefined) setDraft(text);
  };

  const pickMention = (name: string): void => {
    const element = box.current;
    if (mention === undefined || element === null) return;
    const next = applyMention(draft, element.selectionStart, mention, name);
    setDraft(next.text);
    setMention(undefined);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };

  const open = team.commands.filter((command) => command.state === "queued" || command.state === "running");
  const interrupted = team.commands.filter((command) => command.state === "interrupted");

  return (
    <div className="team">
      <div className="main">
        <div className="header">
          <h2>
            {team.displayName}
            {team.sessionCount > 1 && <span className="session-tag">{team.sessionLabel}</span>}
          </h2>
          {team.sessionCount > 1 && (
            <SessionActions
              team={team}
              onClosed={() => {
                const sibling = props.teams.find((one) => one.groupId === team.groupId && one.teamId !== team.teamId);
                if (sibling !== undefined) props.onSelect(sibling.teamId);
              }}
            />
          )}
          <div className="muted">
            {team.projectFolder} · {statusLine(team, now)}
          </div>
          {team.seats
            .filter((seat) => seat.quiet !== undefined)
            .map((seat) => (
              <div className="notice" key={`quiet-${seat.seatId}`}>
                {seat.displayName}：{seat.quiet}
              </div>
            ))}
          <div className="roster">
            {team.seats.map((seat) => (
              <span
                className="chip"
                key={seat.seatId}
                title={seat.answering === undefined ? "" : t("在答：{text}", { text: seat.answering })}
              >
                <span className={`dot ${seat.working ? "busy" : ""}`} />
                {seat.isSecretary ? "★ " : ""}
                {seat.displayName}
                {seat.problem !== undefined && <span title={seat.problem}>⚠️</span>}
                <span className="muted">
                  {seat.role} · {seat.backend} · {seatStatus(seat, now)}
                </span>
              </span>
            ))}
          </div>
        </div>

        <div className="transcript-wrap">
          <div className="transcript" ref={scroller} onScroll={measure}>
            {load.error !== undefined && <div className="error">{load.error}</div>}
            {lines.length === 0 && load.error === undefined && (
              <div className="muted">{t("还没有讨论。在下面写一句话发给团队；用 @名字 只问其中几位。")}</div>
            )}
            {earlier > 0 && (
              // Said, with the way to read them: a record that starts mid-discussion reads as the whole one.
              <div className="row-gap">
                <button type="button" onClick={() => void loadEarlier()} disabled={load.busy}>
                  {t("看更早的（前面还有 {n} 条）", { n: earlier })}
                </button>
              </div>
            )}
            {lines.map((line) => (
              <Line
                key={line.seq}
                teamId={team.teamId}
                line={line}
                projectFolder={team.projectFolder}
                color={line.kind === "seat" ? colorOf.get(line.speaker) : undefined}
                quoted={quoteIds.includes(line.entryId)}
                onQuote={toggleQuote}
                team={team}
                planOffer={designer?.plans.find((offer) => offer.entryId === line.entryId)}
                onOpenTeam={openTeam}
              />
            ))}
            {/* A draft whose source reply is not on screen (or that has none) shows at the end. */}
            {team.agenda.draft !== undefined &&
              !lines.some((line) => line.entryId === team.agenda.draft?.fromEntryId) && <DraftCard team={team} />}
            {designer?.designer === true && <RedraftPlan team={team} />}
            <div ref={bottom} />
          </div>
          {/* Bottom-right of the discussion: to its first line, or to its newest. */}
          <div className="jump">
            <button
              type="button"
              title={t("到最上面（从第一条开始）")}
              aria-label={t("到最上面（从第一条开始）")}
              disabled={(edges.atTop && earlier === 0) || load.busy}
              onClick={() => void toTop()}
            >
              ↑
            </button>
            <button
              type="button"
              title={t("到最下面（最新的一条）")}
              aria-label={t("到最下面（最新的一条）")}
              disabled={edges.atBottom}
              onClick={toBottom}
            >
              ↓
            </button>
          </div>
        </div>

        <div className="composer">
          {(open.length > 0 || interrupted.length > 0) && (
            <div className="commands">
              {open.map((command) => (
                <div className="command" key={command.commandId}>
                  <span>「{command.excerpt}」</span>
                  <span className="muted">
                    {command.seats
                      .map((seat) => `${seat.displayName}:${t(STATE[seat.state] ?? seat.state)}`)
                      .join("  ")}
                  </span>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      void control.run(() =>
                        call("round.cancel", { teamId: team.teamId, commandId: command.commandId }),
                      )
                    }
                  >
                    {command.state === "queued" ? t("撤回") : t("叫停")}
                  </button>
                </div>
              ))}
              {interrupted.map((command) => (
                <div className="command" key={command.commandId}>
                  <span>「{command.excerpt}」</span>
                  <span className="muted">{t("上次没执行完（Squad 关掉了）")}</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      void control.run(() =>
                        call("round.resend", { teamId: team.teamId, commandId: command.commandId }),
                      )
                    }
                  >
                    {t("重发")}
                  </button>
                </div>
              ))}
            </div>
          )}
          {shown !== undefined && (
            <div className="command-result">
              <button type="button" className="link" onClick={() => setShown(undefined)}>
                {t("关闭")}
              </button>
              <div className="body">{shown}</div>
            </div>
          )}
          {slashCandidates(draft).length > 0 && (
            <div className="mention-menu">
              {slashCandidates(draft).map((command) => (
                <button
                  type="button"
                  key={command.name}
                  title={command.usage}
                  onClick={() => {
                    setDraft(`/${command.name} `);
                    box.current?.focus();
                  }}
                >
                  /{command.name} <span className="muted">{command.summary}</span>
                </button>
              ))}
            </div>
          )}
          {candidates.length > 0 && (
            <div className="mention-menu">
              {candidates.map((name) => (
                <button
                  type="button"
                  key={name}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pickMention(name)}
                >
                  @{name}
                </button>
              ))}
            </div>
          )}
          {(quotedLines.length > 0 || attachedHeld.length > 0) && (
            // What rides along with the next command, visible before it is sent.
            <div className="chips">
              {quotedLines.map((line) => (
                <span className="chip accent" key={line.entryId}>
                  {t("引用 {speaker}：{text}", { speaker: line.speaker, text: line.text.slice(0, 24) })}
                  {line.text.length > 24 ? "…" : ""}
                  <button
                    type="button"
                    className="link"
                    onClick={() => toggleQuote(line.entryId)}
                    aria-label={t("取消引用")}
                  >
                    ×
                  </button>
                </span>
              ))}
              {attachedHeld.map((id) => (
                <span className="chip" key={id}>
                  {t("附 {name}", { name: team.materials.find((material) => material.materialId === id)?.name ?? id })}
                  <button type="button" className="link" onClick={() => toggleAttached(id)} aria-label={t("不附这份")}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={box}
            rows={3}
            value={draft}
            placeholder={t("对团队说话…  @名字 只问其中几位（Ctrl+Enter 发送；可以直接粘贴截图）")}
            onPaste={(event) => {
              const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
              if (files.length === 0) return;
              event.preventDefault();
              void paste(files);
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              setMention(mentionDraftAt(event.target.value, event.target.selectionStart));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit();
              if (event.key === "Escape") setMention(undefined);
            }}
          />
          {send.error !== undefined && <div className="error">{send.error}</div>}
          {control.error !== undefined && <div className="error">{control.error}</div>}
          <div className="row">
            <span className="muted" style={{ flex: 1 }}>
              {team.usage.turns > 0 &&
                t("累计 {turns} 轮 · 入 {input} · 出 {output}", {
                  turns: team.usage.turns,
                  input: team.usage.inputTokens,
                  output: team.usage.outputTokens,
                }) + (team.usage.costUsd === undefined ? "" : ` · $${team.usage.costUsd.toFixed(4)}`)}
            </span>
            {open.length > 0 && (
              <button type="button" onClick={() => void control.run(() => call("round.stop", { teamId: team.teamId }))}>
                {t("全部叫停")}
              </button>
            )}
            <Dictate
              configured={(library?.settings.dictationConnectionId ?? "") !== ""}
              onText={(text) => setDraft((current) => (current.trim() === "" ? text : `${current} ${text}`))}
            />
            <button className="primary" type="button" onClick={() => void submit()} disabled={send.busy}>
              {t("发送")}
            </button>
          </div>
        </div>
      </div>
      <aside className="side">
        <AgendaPanel team={team} />
        {designer?.designer === true && <DesignerPanel team={team} />}
        <SeatEditor team={team} onDisbanded={props.onDisbanded} />
        <MaterialsPanel team={team} attached={attachedHeld} onToggle={toggleAttached} />
        <AssistPanel
          team={team}
          onUse={(text) => {
            setDraft(text);
            box.current?.focus();
          }}
        />
        <TeamPromptsPanel team={team} />
        <ContextPanel teamId={team.teamId} coefficient={team.checkpointCoefficient} />
        <AuditPanel team={team} />
      </aside>
    </div>
  );
}

const STATE: Record<string, string> = {
  queued: "排队",
  running: "在答",
  answered: "已答",
  failed: "失败",
  stopped: "停了",
};
