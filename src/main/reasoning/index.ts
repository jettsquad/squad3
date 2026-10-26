/**
 * reasoning — Lil X: the person's own criteria library, and the proxy that
 * decides in their place at an agenda's decision points.
 *
 * 移植自 Squad 2.x packages/reasoning/src/service.ts @ 8dcb903
 * 改动：
 * - 不再是 dsh 插件：模型调用经一个注入的 `run`（compose 用席位适配器、按设置里选的连接跑）。
 * - 判据库目录从设置里读、每次调用时读，改了下一次就用新目录；默认在数据目录下。
 * 其余（先落实例再问模型、只有 reinforce 可能自动生效、退役不删、召回两段式、投放只给
 * 主持人与代理、绝不进席位提示词）照搬。
 *
 * User-level, not team-level: nothing here can reach a table, which is what
 * keeps a criterion from ever landing in a seat's prompt. It shapes how work
 * is organised and judged, never how a participant thinks.
 *
 * Nothing here activates a criterion on its own unless the activation rule
 * says the evidence carries it — and only for a reinforcement. Everything
 * else lands in `proposals/` and waits for the person.
 */
import type { AgendaSpec, DecisionPoint, ProxyDecision, Situation } from "../../shared/index.ts";
import { decideActivation, type ActivationDecision } from "./activation.ts";
import type { Criterion } from "./criterion.ts";
import { checkAbstractness, type AbstractnessReport } from "./decontextualise.ts";
import {
  DELIVERY_LIMIT,
  buildSelectionPrompt,
  formatForSystemChannel,
  parseSelection,
  triggerMatches,
} from "./deliver.ts";
import { buildDistilPrompt, parseDistillation, type Distillation } from "./distil.ts";
import { exportToPool, importAsCandidates, type ExportResult, type PoolEntry } from "./pool.ts";
import { buildProxyPrompt, parseProxyDecision } from "./proxy.ts";
import { ReasoningStore } from "./store.ts";
import { healthOf, type Health } from "./usage.ts";

export type { Criterion, CriterionStatus } from "./criterion.ts";
export type { Health } from "./usage.ts";
export type { AbstractnessReport } from "./decontextualise.ts";

/** The three signals worth learning from. */
export type SignalKind = "veto" | "gate-failure" | "explicit-mark";

export interface LearningSignal {
  readonly kind: SignalKind;
  readonly situation: Situation;
  /** What the machine proposed. */
  readonly proposed: string;
  /** What the person made of it — the moment a standard becomes visible. */
  readonly verdict: string;
  readonly reason?: string | undefined;
  readonly project?: string | undefined;
}

export interface CaptureResult {
  readonly instanceId: string;
  readonly proposal: Criterion;
  readonly relation: Distillation["relation"];
  /** Whether it went straight into the library or waits on the person, and why. Always reported. */
  readonly activation: ActivationDecision;
  readonly applied: boolean;
  /** Whether the distilled claim is actually an abstract. Reported, not enforced. */
  readonly abstractness: AbstractnessReport;
}

export type Verdict = "accept" | "reject";

/** One model call, already on the connection the person chose for Lil X. Throws unless it completed. */
export type ReasoningRun = (label: string, prompt: string, signal?: AbortSignal) => Promise<string>;

export interface Reasoning {
  capture(signal: LearningSignal): Promise<CaptureResult>;
  pending(): Promise<readonly Criterion[]>;
  resolve(id: string, verdict: Verdict, edited?: Criterion): Promise<void>;
  /** Withdraw without losing it: it stops shaping anything, and its reasons stay readable. */
  retire(id: string): Promise<void>;
  /** Put a live criterion back in the queue to be decided again. */
  reopen(id: string): Promise<void>;
  criteria(): Promise<readonly Criterion[]>;
  exportForPool(ids: readonly string[], names?: readonly string[]): Promise<ExportResult>;
  /** Arriving abstracts come in as CANDIDATES; there is no path from an import to an active criterion. */
  importFromPool(entries: readonly PoolEntry[]): Promise<readonly Criterion[]>;
  markOutcome(criterionId: string, outcome: "helpful" | "unhelpful"): Promise<void>;
  health(): Promise<readonly Health[]>;
  /** Suspend what the third scale flagged, and say which. */
  review(): Promise<readonly Health[]>;
  /** The criteria worth surfacing for this situation. At most three. `select` lets a model choose. */
  locate(situation: Situation, select?: boolean): Promise<readonly Criterion[]>;
  /** One brief per phase that declared a situation, for the host looking at a draft. */
  briefForAgenda(agenda: AgendaSpec): Promise<readonly { readonly phase: string; readonly brief: string }[]>;
  /** Decide in the person's place at an agenda's decision point. Throws when no usable answer came back. */
  decide(point: DecisionPoint, signal?: AbortSignal): Promise<ProxyDecision>;
}

const stamp = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createReasoning(options: {
  /** The library folder, read at each call: a folder changed in settings takes effect on the next one. */
  readonly root: () => string;
  readonly run: ReasoningRun;
}): Reasoning {
  const stores = new Map<string, Promise<ReasoningStore>>();
  const storeOf = (): Promise<ReasoningStore> => {
    const root = options.root();
    let found = stores.get(root);
    if (found === undefined) {
      found = (async () => {
        const store = new ReasoningStore(root);
        await store.init();
        return store;
      })();
      // A failed init is not cached: the next call tries again (a folder on a
      // drive that was not mounted yet).
      found.catch(() => stores.delete(root));
      stores.set(root, found);
    }
    return found;
  };

  /**
   * Coarse filter: criteria whose trigger this situation satisfies. Cheap and
   * deterministic; at one person's scale a model reading 「适用边界」 beats any
   * similarity score, so no embedding layer hides the hard part — the trigger.
   */
  const candidatesFor = async (situation: Situation): Promise<readonly Criterion[]> => {
    const held = new Set(situation.features);
    return (await (await storeOf()).criteria()).filter(
      (criterion) =>
        criterion.status !== "retired" &&
        criterion.trigger.action.includes(situation.action) &&
        criterion.trigger.features.every((feature) => held.has(feature)),
    );
  };

  /** Counted at DELIVERY, not candidacy: 「never recalled」 must mean never put in front of anyone. */
  const recordDelivery = async (delivered: readonly Criterion[]): Promise<readonly Criterion[]> => {
    const store = await storeOf();
    const at = new Date().toISOString();
    for (const criterion of delivered) {
      await store.updateUsage(criterion.id, (current) => ({
        ...current,
        delivered: current.delivered + 1,
        lastDeliveredAt: at,
      }));
    }
    return delivered;
  };

  const locate: Reasoning["locate"] = async (situation, select = true) => {
    const store = await storeOf();
    const candidates = (await store.criteria()).filter((criterion) => triggerMatches(criterion, situation));
    if (candidates.length === 0) return [];
    if (!select) return recordDelivery(candidates.slice(0, DELIVERY_LIMIT));
    const reply = await options.run("Lil X · 精选", buildSelectionPrompt(situation, candidates));
    return recordDelivery(parseSelection(reply, candidates));
  };

  const health: Reasoning["health"] = async () => {
    const store = await storeOf();
    const report: Health[] = [];
    for (const criterion of await store.criteria()) {
      report.push(healthOf(await store.usage(criterion.id), criterion.evidence.length));
    }
    return report;
  };

  return {
    // The instance is written FIRST, before the model is asked anything: the
    // occurrence is a fact and the distillation an opinion about it.
    capture: async (signal) => {
      const store = await storeOf();
      const instanceId = `i-${stamp()}`;
      await store.putInstance({
        id: instanceId,
        situation: signal.situation,
        proposed: signal.proposed,
        verdict: signal.verdict,
        ...(signal.reason === undefined ? {} : { reason: signal.reason }),
        ...(signal.project === undefined ? {} : { project: signal.project }),
        at: new Date().toISOString(),
      });
      const candidates = await candidatesFor(signal.situation);
      const reply = await options.run(
        "Lil X · 提炼",
        buildDistilPrompt({
          situation: signal.situation,
          proposed: signal.proposed,
          verdict: signal.verdict,
          ...(signal.reason === undefined ? {} : { reason: signal.reason }),
          candidates,
        }),
      );
      const distilled = parseDistillation(reply, candidates);
      // Reinforce and revise inherit the existing criterion's evidence, so the
      // confidence scale keeps counting.
      const existing =
        distilled.criterionId === undefined
          ? undefined
          : candidates.find((candidate) => candidate.id === distilled.criterionId);
      const proposal: Criterion = {
        id: existing?.id ?? `c-${stamp()}`,
        // The distillation's chosen actions and features when it gave any:
        // copying the instance's makes the trigger as narrow as the one case
        // behind it, and the criterion is then never recalled.
        trigger: existing?.trigger ?? {
          action: (distilled.triggerActions ?? [signal.situation.action]) as Criterion["trigger"]["action"],
          features: (distilled.triggerFeatures ?? signal.situation.features) as typeof signal.situation.features,
        },
        claim: distilled.relation === "reinforce" && existing !== undefined ? existing.claim : distilled.claim,
        ...(distilled.boundary === undefined ? {} : { boundary: distilled.boundary }),
        evidence: [...(existing?.evidence ?? []), instanceId],
        status: "active",
      };
      // A counter-example is a fact about the criterion the moment it is
      // observed, whether or not the person keeps the resulting wording.
      if (distilled.relation === "counter-example" && distilled.criterionId !== undefined) {
        await store.updateUsage(distilled.criterionId, (current) => ({
          ...current,
          counterExamples: current.counterExamples + 1,
        }));
      }
      const abstractness = checkAbstractness(`${proposal.claim}\n${proposal.boundary ?? ""}`, {
        names: signal.project === undefined ? [] : [signal.project],
      });
      const usage = await store.usage(proposal.id);
      // Only a reinforcement is ever eligible: everything else edits what the
      // library claims, and a system approving its own scoring edits grades itself.
      const activation: ActivationDecision =
        distilled.relation === "reinforce"
          ? decideActivation({
              accepted: usage.accepted,
              rejected: usage.rejected,
              guardsIrreversible: proposal.trigger.features.includes("irreversible"),
            })
          : {
              auto: false,
              lowerBound: 0,
              reason: "below-confidence",
              detail: `关系是「${distilled.relation}」，它改动了判据本身的表述，一律由人裁定。`,
            };
      if (activation.auto) {
        await store.putCriterion(proposal);
        return { instanceId, proposal, relation: distilled.relation, activation, applied: true, abstractness };
      }
      await store.putProposal(proposal);
      return { instanceId, proposal, relation: distilled.relation, activation, applied: false, abstractness };
    },

    pending: async () => (await storeOf()).proposals(),

    // An edit counts as an acceptance: the person kept the criterion and
    // changed its wording, which is agreement about the substance.
    resolve: async (id, verdict, edited) => {
      const store = await storeOf();
      const proposal = (await store.proposals()).find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new Error(`没有待裁定的提议 ${id}。`);
      if (verdict === "accept") await store.putCriterion(edited ?? proposal);
      await store.dropProposal(id);
      await store.updateUsage(id, (current) => ({
        ...current,
        accepted: current.accepted + (verdict === "accept" ? 1 : 0),
        rejected: current.rejected + (verdict === "reject" ? 1 : 0),
      }));
    },

    retire: async (id) => {
      const store = await storeOf();
      const criterion = (await store.criteria()).find((candidate) => candidate.id === id);
      if (criterion === undefined) throw new Error(`没有这条判据：${id}。`);
      if (criterion.status === "retired") return;
      await store.putCriterion({ ...criterion, status: "retired" });
    },

    reopen: async (id) => {
      const store = await storeOf();
      const criterion = (await store.criteria()).find((candidate) => candidate.id === id);
      if (criterion === undefined) throw new Error(`没有这条判据：${id}。`);
      await store.putProposal({ ...criterion, status: "active" });
      await store.dropCriterion(id);
    },

    criteria: async () => (await storeOf()).criteria(),

    // Named, never 「everything active」: opting in one at a time is the
    // whole defence against averaging.
    exportForPool: async (ids, names = []) => {
      const all = await (await storeOf()).criteria();
      const chosen = ids.map((id) => {
        const found = all.find((criterion) => criterion.id === id);
        if (found === undefined) throw new Error(`要导出的判据 ${id} 不在库里。`);
        return found;
      });
      return exportToPool(chosen, { names });
    },

    importFromPool: async (entries) => {
      const store = await storeOf();
      const candidates = importAsCandidates(entries);
      for (const candidate of candidates) await store.putProposal(candidate);
      return candidates;
    },

    markOutcome: async (criterionId, outcome) => {
      await (
        await storeOf()
      ).updateUsage(criterionId, (current) => ({
        ...current,
        helpful: current.helpful + (outcome === "helpful" ? 1 : 0),
        unhelpful: current.unhelpful + (outcome === "unhelpful" ? 1 : 0),
      }));
    },

    health,

    review: async () => {
      const store = await storeOf();
      const flagged = (await health()).filter((entry) => entry.verdict === "never-contradicted");
      for (const entry of flagged) {
        const criterion = (await store.criteria()).find((one) => one.id === entry.criterionId);
        if (criterion !== undefined && criterion.status === "active") {
          await store.putCriterion({ ...criterion, status: "suspect" });
        }
      }
      return flagged;
    },

    locate,

    // Delivered when the person is looking at the DRAFT: confirmation is when
    // they can still act, and nothing inside a running agenda can reach here.
    briefForAgenda: async (agenda) => {
      const briefs: { phase: string; brief: string }[] = [];
      for (const phase of agenda.phases) {
        if (phase.situation === undefined) continue;
        const situation = { action: phase.situation.action, features: phase.situation.features };
        briefs.push({ phase: phase.title, brief: formatForSystemChannel(await locate(situation), situation.features) });
      }
      return briefs;
    },

    // The person's own criteria for this kind of decision travel with the
    // question — to Lil X and nowhere else, never into a seat's prompt.
    decide: async (point, signal) => {
      const situation = point.phase.situation;
      const criteria =
        situation === undefined
          ? []
          : await recordDelivery(
              (await candidatesFor({ action: situation.action, features: situation.features })).slice(
                0,
                DELIVERY_LIMIT,
              ),
            );
      const reply = await options.run("Lil X · 代理主持", buildProxyPrompt(point, criteria), signal);
      return parseProxyDecision(reply, point);
    },
  };
}
