/**
 * BlocksPage.tsx — the prompt fragment library.
 *
 * 移植自 Squad 2.x packages/console/src/client/blocks.tsx @ 8dcb903
 * 改动：多了上移/下移（2.x 有 reorder 接口，界面没接）；文案直接写中文。
 *
 * User-level, beside the agents and the connections, because a fragment
 * outlives the team that first needed it. A team COPIES what it uses, so
 * editing here changes what the NEXT team gets and leaves running teams alone.
 */
import { useState, type JSX } from "react";
import type { PromptBlockWire } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { libraryChanged, useLibrary } from "./library.ts";
import { t } from "./locale.ts";

const blank = (): PromptBlockWire => ({ blockId: "", name: "", text: "" });

export function BlocksPage(): JSX.Element {
  const { library, error: loadError } = useLibrary();
  const [draft, setDraft] = useState<PromptBlockWire>(blank());
  const action = useAction();
  const blocks = library?.blocks ?? [];
  const editing = blocks.some((block) => block.blockId === draft.blockId);

  const save = async (): Promise<void> => {
    const blockId = draft.blockId === "" ? `blk-${Date.now().toString(36)}` : draft.blockId;
    const done = await action.run(() => call("blocks.save", { block: { ...draft, blockId } }));
    libraryChanged();
    if (done !== undefined) setDraft(blank());
  };

  const move = async (index: number, delta: number): Promise<void> => {
    const ids = blocks.map((block) => block.blockId);
    const [held] = ids.splice(index, 1);
    if (held === undefined) return;
    ids.splice(index + delta, 0, held);
    await action.run(() => call("blocks.reorder", { blockIds: ids }));
    libraryChanged();
  };

  return (
    <main className="main scroll">
      <div className="two-column">
        <div className="page">
          <h2>{editing ? t("编辑片段") : t("新建片段")}</h2>
          {loadError !== undefined && <div className="error">{loadError}</div>}
          <input
            placeholder={t("名字，比如「完整工作方法」")}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          {/* The name is not a label: it becomes a heading inside every prompt that carries this block. */}
          <p className="muted">{t("名字会成为提示词里的小标题——席位读到的就是它。")}</p>
          <textarea
            rows={12}
            placeholder={t("写这一段的正文。\n对哪几个席位成立由团队那边决定，这里只管内容。")}
            value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          {action.error !== undefined && <div className="error">{action.error}</div>}
          <div className="row-gap">
            <button type="button" className="primary" onClick={() => void save()} disabled={action.busy}>
              {editing ? t("保存") : t("建这段")}
            </button>
            <button type="button" onClick={() => setDraft(blank())}>
              {t("清空")}
            </button>
          </div>
          <p className="muted">
            {t(
              "改这里只影响之后新加这段的团队。已经用上它的团队各拿着自己的副本，要它们更新，到那支团队的「提示词」里点开这段，用库版本。",
            )}
          </p>
        </div>

        <div className="page">
          <h2>{t("已有片段（{n}）", { n: blocks.length })}</h2>
          {library !== undefined && blocks.length === 0 && (
            <p className="muted">{t("还没有。左边写一段，之后每支团队都能直接挂上它。")}</p>
          )}
          {blocks.map((block, index) => (
            <div className="card" key={block.blockId}>
              <div className="row-gap" style={{ margin: 0 }}>
                <strong>{block.name}</strong>
                <span className="muted">{t("{n} 字", { n: block.text.trim().length })}</span>
                <span style={{ flex: 1 }} />
                <button type="button" className="link" disabled={index === 0} onClick={() => void move(index, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={index === blocks.length - 1}
                  onClick={() => void move(index, 1)}
                >
                  ↓
                </button>
              </div>
              <div className="muted">{block.text.trim().slice(0, 90)}…</div>
              <div className="row-gap">
                <button type="button" onClick={() => setDraft(block)}>
                  {t("编辑")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Asked first, and the question says what survives.
                    if (
                      !window.confirm(
                        t("删掉「{name}」？已经用它的团队不受影响，但库里就没有了。", { name: block.name }),
                      )
                    )
                      return;
                    void action.run(() => call("blocks.remove", { blockId: block.blockId })).then(libraryChanged);
                  }}
                >
                  {t("删除")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
