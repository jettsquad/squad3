/**
 * CriteriaPage.tsx — Lil X's library: what you judge by, and where a verdict is given.
 *
 * 移植自 Squad 2.x packages/console/src/client/criteria.tsx @ 8dcb903
 * 改动：采纳前可以改措辞和边界（2.x 的服务支持 edited，页面没接）；触发条件用中文标签显示；
 * 文案走 t()。
 *
 * Evidence is a COUNT, never the instances: instances are your own occurrences
 * with project detail in them, and they never leave the library folder.
 */
import { useEffect, useState, type JSX } from "react";
import { ACTION_KIND_LABELS, FEATURE_FLAG_LABELS } from "../../shared/situation.ts";
import type { CriterionWire } from "../../shared/wire.ts";
import { call, useAction } from "./api.ts";
import { t } from "./locale.ts";

function Trigger({ trigger }: { readonly trigger: CriterionWire["trigger"] }): JSX.Element {
  const words = [
    ...trigger.action.map((action) => t((ACTION_KIND_LABELS as Record<string, string>)[action] ?? action)),
    ...trigger.features.map((feature) => t((FEATURE_FLAG_LABELS as Record<string, string>)[feature] ?? feature)),
  ];
  return <span>{words.length === 0 ? t("任何场合") : words.join(" · ")}</span>;
}

/** A proposal, with its wording editable before it is adopted: 「差不多，但说得比我的意思宽」 is the common verdict. */
function Proposal(props: { readonly criterion: CriterionWire; readonly onDone: () => void }): JSX.Element {
  const { criterion } = props;
  const [claim, setClaim] = useState(criterion.claim);
  const [boundary, setBoundary] = useState(criterion.boundary ?? "");
  const action = useAction();
  const edited = claim.trim() !== criterion.claim || boundary.trim() !== (criterion.boundary ?? "");
  const resolve = (verdict: "accept" | "reject"): void =>
    void action
      .run(() =>
        call("criteria.resolve", {
          id: criterion.id,
          verdict,
          ...(verdict === "accept" && edited ? { claim: claim.trim(), boundary: boundary.trim() } : {}),
        }),
      )
      .then((done) => {
        if (done !== undefined) props.onDone();
      });
  return (
    <div className="card">
      <textarea rows={2} value={claim} onChange={(event) => setClaim(event.target.value)} />
      <input
        value={boundary}
        placeholder={t("在哪里不成立（不写，它就是一句没有条件的口号）")}
        onChange={(event) => setBoundary(event.target.value)}
      />
      {/* Said out loud: a criterion with no boundary is how a useful judgement turns into dogma. */}
      {boundary.trim() === "" && <div className="muted">{t("还没有写「在哪里不成立」。")}</div>}
      <div className="muted">
        {t("触发：")}
        <Trigger trigger={criterion.trigger} />
        {t(" · {n} 条证据", { n: criterion.evidence })}
      </div>
      <div className="row-gap">
        <button type="button" className="primary" disabled={action.busy} onClick={() => resolve("accept")}>
          {edited ? t("按改过的采纳") : t("采纳")}
        </button>
        <button type="button" disabled={action.busy} onClick={() => resolve("reject")}>
          {t("否掉")}
        </button>
      </div>
      {action.error !== undefined && <div className="error">{action.error}</div>}
    </div>
  );
}

export function CriteriaPage(): JSX.Element {
  const [data, setData] = useState<{ pending: CriterionWire[]; live: CriterionWire[]; folder: string } | undefined>(
    undefined,
  );
  const [tick, setTick] = useState(0);
  const load = useAction();
  const action = useAction();
  useEffect(() => {
    void load.run(async () => setData(await call("criteria.list", {})));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const reload = (): void => setTick((value) => value + 1);

  return (
    <main className="main scroll">
      <div className="page">
        <h2>{t("判据库")}</h2>
        <p className="muted">
          {t(
            "Lil X 从你推翻机器提议的时刻里学你的标准：你改过秘书的议程草案再确认，或者在你自己的发言上点「记下来」。学到的先放在这里等你裁定；只有被反复证实的才可能自动生效。判据只给你和代理看，绝不进任何席位的提示词。",
          )}
        </p>
        {data !== undefined && (
          <p className="muted">{t("库在：{folder}（纯文本，可以放进 git）", { folder: data.folder })}</p>
        )}
        {load.error !== undefined && <div className="error">{load.error}</div>}

        <div className="section-title">{t("待裁定（{n}）", { n: data?.pending.length ?? 0 })}</div>
        {data !== undefined && data.pending.length === 0 && <p className="muted">{t("没有待裁定的。")}</p>}
        {data?.pending.map((criterion) => (
          <Proposal key={criterion.id} criterion={criterion} onDone={reload} />
        ))}

        <div className="section-title">{t("已生效（{n}）", { n: data?.live.length ?? 0 })}</div>
        {data !== undefined && data.live.length === 0 && <p className="muted">{t("还没有生效的判据。")}</p>}
        {data?.live.map((criterion) => (
          <div className="card" key={criterion.id}>
            <div className="row-gap" style={{ margin: 0 }}>
              <strong>{criterion.claim}</strong>
              {criterion.status !== "active" && (
                <span className="badge bad">{criterion.status === "retired" ? t("已停用") : t("待复核")}</span>
              )}
            </div>
            {criterion.boundary !== undefined && (
              <div className="muted">{t("不适用于：{text}", { text: criterion.boundary })}</div>
            )}
            <div className="muted">
              {t("触发：")}
              <Trigger trigger={criterion.trigger} />
              {t(" · {n} 条证据", { n: criterion.evidence })}
            </div>
            {criterion.health !== undefined && criterion.health.verdict !== "ok" && (
              <div className="muted">{criterion.health.detail}</div>
            )}
            {/* Adjudication is not one-way: a criterion adopted in haste needs a route back. */}
            <div className="row-gap">
              <button
                type="button"
                className="link"
                title={t("放回待裁定队列，重新裁一次——措辞不合适了，或者当初采纳得太快")}
                onClick={() => void action.run(() => call("criteria.reopen", { id: criterion.id })).then(reload)}
              >
                {t("退回待裁定")}
              </button>
              {criterion.status !== "retired" && (
                <button
                  type="button"
                  className="link"
                  title={t("不再被捞出来，但文件留着——主张、边界、证据都还读得到")}
                  onClick={() => void action.run(() => call("criteria.retire", { id: criterion.id })).then(reload)}
                >
                  {t("停用")}
                </button>
              )}
            </div>
          </div>
        ))}
        {action.error !== undefined && <div className="error">{action.error}</div>}
      </div>
    </main>
  );
}
