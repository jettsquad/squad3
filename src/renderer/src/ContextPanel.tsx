/**
 * ContextPanel.tsx — how far the discussion is from the next fold, and what stands in for the earlier part.
 *
 * Shown BEFORE the fold happens: learning afterwards that later answers were
 * built on a summary is learning it too late (2.x §16.2).
 */
import { useEffect, useState, type JSX } from "react";
import { DEFAULT_CHECKPOINT_COEFFICIENT } from "../../shared/team-checkpoint-threshold.ts";
import type { ContextStateView } from "../../shared/wire.ts";
import { call, useAction, useTeamChanges } from "./api.ts";
import { t } from "./locale.ts";

const HOLD: Record<string, string> = {
  "below-threshold": "未到阈值",
  "already-running": "正在折叠",
  "team-busy": "等席位答完再折叠",
};

export function ContextPanel(props: {
  readonly teamId: string;
  readonly coefficient?: number | undefined;
}): JSX.Element {
  const tick = useTeamChanges(props.teamId);
  const [state, setState] = useState<ContextStateView | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [percentDraft, setPercentDraft] = useState<string | undefined>(undefined);
  const load = useAction();
  const act = useAction();

  useEffect(() => {
    void load.run(async () => setState(await call("context.state", { teamId: props.teamId })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.teamId, tick]);

  if (state === undefined) return <div className="panel">{load.error ?? "…"}</div>;
  const percent = Math.min(100, Math.round((state.accumulated / state.limit) * 100));

  return (
    <div className="panel">
      <div className="panel-title">{t("上下文")}</div>
      <div className="muted">
        {t("距下次折叠：约 {used} / {limit} token", {
          used: state.accumulated.toLocaleString(),
          limit: state.limit.toLocaleString(),
        })}
        {state.folding
          ? ` · ${t("正在折叠…")}`
          : state.holdReason !== undefined
            ? ` · ${t(HOLD[state.holdReason] ?? "")}`
            : ""}
      </div>
      <div className="meter">
        <div style={{ width: `${percent}%` }} />
      </div>
      {state.lastFailure !== undefined && <div className="error">{state.lastFailure}</div>}
      <div className="row-gap">
        <button
          type="button"
          disabled={state.folding || act.busy}
          onClick={() => void act.run(() => call("context.fold", { teamId: props.teamId }))}
        >
          {t("现在折叠")}
        </button>
        <span className="muted">{t("折叠过 {n} 次", { n: state.history.length })}</span>
      </div>
      {/* Per team (需求 C6): a team that argues over long documents wants a
          bigger window before folding than one that trades short answers. */}
      {percentDraft === undefined ? (
        <div className="row-gap">
          <span className="muted">
            {t("折叠阈值：上下文窗口的 {percent}%", {
              percent: Math.round((props.coefficient ?? DEFAULT_CHECKPOINT_COEFFICIENT) * 100),
            })}
            {props.coefficient === undefined ? t("（默认）") : ""}
          </span>
          <button
            type="button"
            className="link"
            onClick={() =>
              setPercentDraft(String(Math.round((props.coefficient ?? DEFAULT_CHECKPOINT_COEFFICIENT) * 100)))
            }
          >
            {t("改")}
          </button>
        </div>
      ) : (
        <div className="row-gap">
          <input
            className="narrow"
            value={percentDraft}
            inputMode="numeric"
            onChange={(event) => setPercentDraft(event.target.value)}
          />
          <span className="muted">{t("%（5–90）")}</span>
          <button
            type="button"
            onClick={() =>
              void act
                .run(async () => {
                  const value = Number(percentDraft.trim());
                  if (!Number.isFinite(value)) throw new Error(t("「{value}」不是一个数。", { value: percentDraft }));
                  return call("teams.setCoefficient", { teamId: props.teamId, coefficient: value / 100 });
                })
                .then((done) => {
                  if (done !== undefined) setPercentDraft(undefined);
                })
            }
          >
            {t("存")}
          </button>
          <button
            type="button"
            className="link"
            onClick={() =>
              void act
                .run(() => call("teams.setCoefficient", { teamId: props.teamId, coefficient: null }))
                .then((done) => {
                  if (done !== undefined) setPercentDraft(undefined);
                })
            }
          >
            {t("改回默认")}
          </button>
        </div>
      )}
      {act.error !== undefined && <div className="error">{act.error}</div>}
      {state.checkpoint === undefined ? (
        <div className="muted">{t("还没有检查点：席位看到的是完整讨论。")}</div>
      ) : (
        <div>
          <button type="button" className="link" onClick={() => setOpen(!open)}>
            {open ? t("收起当前检查点") : t("看当前检查点")}
          </button>
          {open && <div className="request">{state.checkpoint.text}</div>}
          <div className="row-gap">
            <button
              type="button"
              disabled={act.busy}
              title={t("作废后，被折叠掉的原文重新进入席位的上下文；原文一直都在，没有消失。")}
              onClick={() =>
                void act.run(() =>
                  call("context.revoke", { teamId: props.teamId, checkpointId: state.checkpoint?.checkpointId ?? "" }),
                )
              }
            >
              {t("作废这个检查点")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
