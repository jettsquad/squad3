/**
 * TeamPrompts.tsx — which shared blocks this team uses, and who reads them.
 *
 * 移植自 Squad 2.x packages/console/src/client/team-prompts.tsx @ 8dcb903
 * 改动：样式换成 3 的类名；整体写入走 teams.setPrompts，写回库走 blocks.save；逻辑不变。
 *
 * Two things live here and they are not the same thing: the blocks EVERY seat
 * reads, and named sets that give some blocks to some seats. Sets rather than
 * a seat×block grid because membership overlaps, and a named set says WHY
 * those seats are grouped.
 *
 * The whole shape is saved in one call, so the three parts can never
 * half-apply into a state nobody wrote.
 */
import { useEffect, useState, type JSX } from "react";
import { blocksForSeat, checkPromptSet } from "../../shared/prompt-blocks.ts";
import type { PromptBlockWire, TeamPromptsWire, TeamSummary } from "../../shared/wire.ts";
import { call } from "./api.ts";
import { libraryChanged, useLibrary } from "./library.ts";
import { t } from "./locale.ts";

type PromptSetWire = TeamPromptsWire["sets"][number];

function Chip(props: {
  readonly label: string;
  readonly tone?: "accent" | "warn";
  readonly onOpen?: () => void;
  readonly onRemove?: () => void;
}): JSX.Element {
  return (
    <span className={`chip ${props.tone ?? ""}`}>
      {props.onOpen === undefined ? (
        props.label
      ) : (
        <button type="button" className="link" onClick={props.onOpen} title={t("看这一段正文，或改本队这一份")}>
          {props.label}
        </button>
      )}
      {props.onRemove === undefined ? null : (
        <button
          type="button"
          className="link"
          onClick={props.onRemove}
          aria-label={t("移除 {name}", { name: props.label })}
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Editing one block, in one team. Three actions because a person means three
 * different things: this team from the next round; and every team built
 * after; or throw away what this team changed.
 */
function BlockEditor(props: {
  readonly copy: PromptBlockWire;
  readonly library: PromptBlockWire | undefined;
  readonly edited: boolean;
  readonly busy: boolean;
  readonly onSave: (next: PromptBlockWire, alsoLibrary: boolean) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { copy, library, edited, busy } = props;
  const [text, setText] = useState(copy.text);
  const dirty = text !== copy.text;
  return (
    <div className="card">
      <div className="row-gap" style={{ margin: 0 }}>
        <strong>{copy.name}</strong>
        <span className="muted">
          {edited ? t("本队这一份和库里不一样") : library === undefined ? t("库里已经没有这一段了") : t("和库里一致")}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" className="link" onClick={props.onClose}>
          {t("收起")}
        </button>
      </div>
      <textarea rows={8} value={text} onChange={(event) => setText(event.target.value)} />
      <div className="row-gap">
        <button type="button" disabled={busy || !dirty} onClick={() => props.onSave({ ...copy, text }, false)}>
          {t("保存到本队")}
        </button>
        <button
          type="button"
          disabled={busy || (!dirty && !edited)}
          onClick={() => props.onSave({ ...copy, text }, true)}
        >
          {t("同时写回库")}
        </button>
        {library === undefined || (!edited && !dirty) ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              // Asked: the one button here that destroys something written on purpose.
              if (
                window.confirm(t("用库里的版本覆盖本队这一份？本队对「{name}」的修改会没有。", { name: copy.name }))
              ) {
                setText(library.text);
                props.onSave({ ...copy, name: library.name, text: library.text }, false);
              }
            }}
          >
            {t("放弃修改，用库版本")}
          </button>
        )}
      </div>
      <div className="muted">
        {t("保存到本队：下一轮生效，只影响这支团队。写回库：还会影响之后新加这段的团队；已经建好的别的团队不受影响。")}
      </div>
    </div>
  );
}

export function TeamPromptsPanel(props: { readonly team: TeamSummary }): JSX.Element {
  const { team } = props;
  const { library } = useLibrary();
  const blocks = library?.blocks ?? [];
  const prompts = team.prompts;
  const edited = new Set(team.editedBlockIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState(team.seats[0]?.seatId ?? "");
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState(prompts.teamBlockIds.length > 0 || prompts.sets.length > 0);

  const opened = prompts.blocks.find((block) => block.blockId === editing);
  const nameOf = (blockId: string): string =>
    prompts.blocks.find((block) => block.blockId === blockId)?.name ?? t("已删除的片段（{id}）", { id: blockId });

  const push = (next: TeamPromptsWire, then?: () => Promise<unknown>): void => {
    setBusy(true);
    setError(undefined);
    void call("teams.setPrompts", { teamId: team.teamId, prompts: next })
      .then(() => then?.())
      .catch((problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem)))
      .finally(() => setBusy(false));
  };

  /** Copy a library entry into this team, then place it. */
  const adopt = (blockId: string, place: (prompts: TeamPromptsWire, blockId: string) => TeamPromptsWire): void => {
    const entry = blocks.find((block) => block.blockId === blockId);
    if (entry === undefined) return;
    const held = prompts.blocks.some((block) => block.blockId === blockId);
    const withCopy: TeamPromptsWire = held
      ? prompts
      : { ...prompts, blocks: [...prompts.blocks, { blockId, name: entry.name, text: entry.text }] };
    push(place(withCopy, blockId));
  };

  return (
    <div className="panel">
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"}{" "}
        {t("提示词（全员 {blocks} 段 · {sets} 个集合）", {
          blocks: prompts.teamBlockIds.length,
          sets: prompts.sets.length,
        })}
      </button>
      {open && (
        <>
          <div className="muted">
            {t("片段来自提示词库，挂上时拷贝一份到本队。每个席位读到的顺序：全员的 → 集合的 → 它自己的职责。")}
          </div>
          {error !== undefined && <div className="error">{error}</div>}
          {opened !== undefined && (
            <BlockEditor
              key={opened.blockId}
              copy={opened}
              library={blocks.find((block) => block.blockId === opened.blockId)}
              edited={edited.has(opened.blockId)}
              busy={busy}
              onClose={() => setEditing(undefined)}
              onSave={(next, alsoLibrary) =>
                // The team's copy first: a write-back that landed while the
                // copy failed would leave the library ahead of the team.
                push(
                  {
                    ...prompts,
                    blocks: prompts.blocks.map((block) => (block.blockId === next.blockId ? next : block)),
                  },
                  alsoLibrary
                    ? async () => {
                        await call("blocks.save", { block: next });
                        libraryChanged();
                      }
                    : undefined,
                )
              }
            />
          )}

          <div className="section-title">{t("全员都读")}</div>
          <div className="chips">
            {prompts.teamBlockIds.map((blockId) => (
              <Chip
                key={blockId}
                label={nameOf(blockId) + (edited.has(blockId) ? ` · ${t("已改过")}` : "")}
                tone={edited.has(blockId) ? "warn" : "accent"}
                onOpen={() => setEditing(blockId)}
                onRemove={() => push({ ...prompts, teamBlockIds: prompts.teamBlockIds.filter((id) => id !== blockId) })}
              />
            ))}
            <select
              value=""
              disabled={busy}
              onChange={(event) => {
                const blockId = event.target.value;
                if (blockId !== "")
                  adopt(blockId, (next, id) => ({ ...next, teamBlockIds: [...next.teamBlockIds, id] }));
              }}
            >
              <option value="">{t("＋ 加片段…")}</option>
              {blocks
                .filter((block) => !prompts.teamBlockIds.includes(block.blockId))
                .map((block) => (
                  <option key={block.blockId} value={block.blockId}>
                    {block.name}
                  </option>
                ))}
            </select>
          </div>
          {blocks.length === 0 && <div className="muted">{t("提示词库是空的——先到左边「提示词库」写一段。")}</div>}

          <div className="section-title">{t("集合（按顺序拼装 · 一个席位可以在多个集合里）")}</div>
          {prompts.sets.map((set, index) => (
            <SetCard
              key={set.setId}
              set={set}
              index={index}
              warnings={checkPromptSet(set, {
                blockIds: prompts.blocks.map((block) => block.blockId),
                seatIds: team.seats.map((seat) => seat.seatId),
              })
                .filter((problem) => problem.severity === "warning")
                .map((problem) => problem.detail)}
              team={team}
              prompts={prompts}
              library={blocks}
              edited={edited}
              busy={busy}
              nameOf={nameOf}
              onOpen={setEditing}
              onAdopt={adopt}
              onPush={push}
            />
          ))}
          <div className="row-gap">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                push({
                  ...prompts,
                  sets: [
                    ...prompts.sets,
                    {
                      setId: `set-${Date.now().toString(36)}`,
                      name: t("集合 {n}", { n: prompts.sets.length + 1 }),
                      blockIds: [],
                      seatIds: [],
                    },
                  ],
                })
              }
            >
              {t("新建集合")}
            </button>
            <span className="muted">{t("先给它片段和席位，空集合不会有任何效果。")}</span>
          </div>

          <div className="section-title">
            {t("实际读到的：")}
            <select value={preview} onChange={(event) => setPreview(event.target.value)}>
              {team.seats.map((seat) => (
                <option key={seat.seatId} value={seat.seatId}>
                  {seat.displayName}
                </option>
              ))}
            </select>
          </div>
          {/* 「这个席位为什么这么答」 must stay answerable in one place. */}
          <ol className="plan-list">
            {blocksForSeat(prompts, preview).map((block) => (
              <li key={block.blockId}>
                <strong>## {block.name}</strong>
                <span className="muted"> ← {prompts.teamBlockIds.includes(block.blockId) ? t("全员") : t("集合")}</span>
              </li>
            ))}
            <li>
              <strong>{t("## 你的职责")}</strong>
              <span className="muted"> {t("← 席位自己的提示词")}</span>
            </li>
          </ol>
        </>
      )}
    </div>
  );
}

function SetCard(props: {
  readonly set: PromptSetWire;
  readonly index: number;
  /** What is merely useless about it. Never a refusal — see `checkPromptSet`. */
  readonly warnings: readonly string[];
  readonly team: TeamSummary;
  readonly prompts: TeamPromptsWire;
  readonly library: readonly PromptBlockWire[];
  readonly edited: ReadonlySet<string>;
  readonly busy: boolean;
  readonly nameOf: (blockId: string) => string;
  readonly onOpen: (blockId: string) => void;
  readonly onAdopt: (blockId: string, place: (prompts: TeamPromptsWire, blockId: string) => TeamPromptsWire) => void;
  readonly onPush: (prompts: TeamPromptsWire) => void;
}): JSX.Element {
  const { set, index, prompts, busy } = props;
  // Typed locally, committed on blur: pushing every keystroke had the field
  // fighting the person typing into it.
  const [name, setName] = useState(set.name);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setName(set.name);
  }, [set.name, typing]);

  const replace = (next: PromptSetWire): TeamPromptsWire => ({
    ...prompts,
    sets: prompts.sets.map((one) => (one.setId === set.setId ? next : one)),
  });
  const move = (to: number): void => {
    const sets = [...prompts.sets];
    const [held] = sets.splice(index, 1);
    if (held === undefined) return;
    sets.splice(Math.max(0, Math.min(sets.length, to)), 0, held);
    props.onPush({ ...prompts, sets });
  };

  return (
    <div className="card">
      <div className="row-gap" style={{ margin: 0 }}>
        <input
          value={name}
          placeholder={t("集合的名字，比如「产出型席位」")}
          onChange={(event) => {
            setTyping(true);
            setName(event.target.value);
          }}
          onBlur={() => {
            setTyping(false);
            if (name !== set.name) props.onPush(replace({ ...set, name }));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <button type="button" className="link" disabled={busy || index === 0} onClick={() => move(index - 1)}>
          ↑
        </button>
        <button
          type="button"
          className="link"
          disabled={busy || index === prompts.sets.length - 1}
          onClick={() => move(index + 1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="link danger"
          onClick={() => {
            if (window.confirm(t("删掉集合「{name}」？片段本身还在，只是不再挂给这些席位。", { name: set.name }))) {
              props.onPush({ ...prompts, sets: prompts.sets.filter((one) => one.setId !== set.setId) });
            }
          }}
        >
          {t("删除")}
        </button>
      </div>
      {/* On the card that has them: a warning nobody can place reads as a refusal. */}
      {props.warnings.map((warning) => (
        <div key={warning} className="muted">
          ⚠ {warning}
        </div>
      ))}
      <div className="muted">{t("片段")}</div>
      <div className="chips">
        {set.blockIds.map((blockId) => (
          <Chip
            key={blockId}
            label={props.nameOf(blockId) + (props.edited.has(blockId) ? ` · ${t("已改过")}` : "")}
            tone={props.edited.has(blockId) ? "warn" : "accent"}
            onOpen={() => props.onOpen(blockId)}
            onRemove={() => props.onPush(replace({ ...set, blockIds: set.blockIds.filter((id) => id !== blockId) }))}
          />
        ))}
        <select
          value=""
          disabled={busy}
          onChange={(event) => {
            const blockId = event.target.value;
            if (blockId !== "") {
              props.onAdopt(blockId, (next, id) => ({
                ...next,
                sets: next.sets.map((one) =>
                  one.setId === set.setId ? { ...one, blockIds: [...one.blockIds, id] } : one,
                ),
              }));
            }
          }}
        >
          <option value="">{t("＋ 加片段…")}</option>
          {props.library
            .filter((block) => !set.blockIds.includes(block.blockId))
            .map((block) => (
              <option key={block.blockId} value={block.blockId}>
                {block.name}
              </option>
            ))}
        </select>
      </div>
      <div className="muted">{t("席位")}</div>
      <div className="chips">
        {set.seatIds.map((seatId) => (
          <Chip
            key={seatId}
            label={props.team.seats.find((seat) => seat.seatId === seatId)?.displayName ?? seatId}
            onRemove={() => props.onPush(replace({ ...set, seatIds: set.seatIds.filter((id) => id !== seatId) }))}
          />
        ))}
        <select
          value=""
          disabled={busy}
          onChange={(event) => {
            const seatId = event.target.value;
            if (seatId !== "") props.onPush(replace({ ...set, seatIds: [...set.seatIds, seatId] }));
          }}
        >
          <option value="">{t("＋ 加席位…")}</option>
          {props.team.seats
            .filter((seat) => !set.seatIds.includes(seat.seatId))
            .map((seat) => (
              <option key={seat.seatId} value={seat.seatId}>
                {seat.displayName}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}
