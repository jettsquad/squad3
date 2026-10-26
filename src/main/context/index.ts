/**
 * context — what each seat is shown, and folding the discussion into checkpoints.
 *
 * 移植自 Squad 2.x packages/context/src/service.ts @ 8dcb903
 * 改动：数据来源从「dsh 会话日志 + storage domain 两处」换成 3 自己的一份团队日志——检查点和
 * 作废就是日志里的两种事件，`merge.ts` 仍然负责按 `coversUpTo` 把检查点插回正确位置（日志里的
 * 位置 ≠ 覆盖范围：秘书写检查点时团队不停，期间落地的发言排在它前面却不在它里面）。
 * 判据库（Lil X）的 `brief` 在阶段 4 接入；产出索引在阶段 4 随议程落盘接入，现在恒为空。
 *
 * The window, the merge, the fold plan and the timeline are the 2.x pure
 * functions, unchanged, with their tests. This file only feeds them.
 */
import {
  accumulatedTokens,
  evaluateThreshold,
  thresholdTokensFor,
  type ThresholdDecision,
} from "../../shared/index.ts";
import type { SeatSpec } from "../../shared/seat.ts";
import { spokenLines, type CheckpointRecordedEvent, type TeamLogEvent } from "../../shared/team-log.ts";
import type { Secretary } from "../secretary/index.ts";
import type { Store } from "../store/index.ts";
import { mergeCheckpoints, type MergeableCheckpoint, type TranscriptEntry } from "./merge.ts";
import { planFold } from "./plan.ts";
import { renderTimeline, SPEECH_KIND } from "./timeline.ts";
import { CHECKPOINT_KIND, selectContextEvents, tailForSeat, tailSince, type SelectableEvent } from "./window.ts";

export { CHECKPOINT_TIMELINE_PREFIX } from "./timeline.ts";

/**
 * Tail past which a seat about to open a fresh conversation waits for a fold.
 * Below it carrying the tail is cheaper than a secretary call; above it,
 * folding first makes every fresh seat in the round start small — and the
 * checkpoint is shared, so one fold serves all of them.
 */
export const FRESH_START_FOLD_TOKENS = 30_000;

/** What the context layer needs to know about a team, read fresh each time. */
export interface TeamFacts {
  readonly displayName: string;
  readonly hostDisplayName: string;
  readonly projectFolder: string;
  readonly checkpointCoefficient?: number | undefined;
  /** A seat is answering right now. */
  readonly busy: boolean;
  /** Commands still waiting for an answer, by id. A fold stops before the first. */
  readonly openCommandIds: readonly string[];
  /** Who does the folding: the team's designated secretary, or the default. */
  readonly secretary: SeatSpec;
}

export interface WindowOptions {
  /** The display name of a seat continuing its own CLI conversation. */
  readonly continuingAs?: string | undefined;
  /** The last entry this seat was shown last time. */
  readonly seenUpTo?: string | undefined;
  /** Entries this seat must not be shown (the command it is answering, and later ones queued for it). */
  readonly exclude?: readonly string[] | undefined;
}

export interface ContextState extends ThresholdDecision {
  readonly folding: boolean;
  readonly checkpoint?: { readonly checkpointId: string; readonly text: string; readonly at: number } | undefined;
  /** Every checkpoint, newest first, revoked ones included and marked. */
  readonly history: readonly {
    readonly checkpointId: string;
    readonly at: number;
    readonly revoked: boolean;
  }[];
  /** The last automatic fold that failed, so it is seen rather than lost. */
  readonly lastFailure?: string | undefined;
}

export interface TeamContext {
  windowFor(teamId: string, options?: WindowOptions): readonly string[];
  state(teamId: string): ContextState;
  /** Fold now. Throws when there is nothing to fold or a fold is running. */
  fold(teamId: string): Promise<CheckpointRecordedEvent>;
  revoke(teamId: string, checkpointId: string): void;
  /** Every seat went quiet: fold if the record has grown past the limit. Never rejects. */
  roundEnded(teamId: string): void;
  /** A seat is about to open a fresh conversation: fold first if its tail would be long. Never rejects. */
  beforeFreshStart(teamId: string): Promise<void>;
  /**
   * Have the secretary rewrite a project file that outgrew its limit. The
   * BODY only; `undefined` when it could not, which is never a round's failure.
   */
  compactProjectMemory(teamId: string, file: string, text: string): Promise<string | undefined>;
}

export interface ContextDeps {
  readonly store: Store;
  readonly secretary: Secretary;
  readonly facts: (teamId: string) => TeamFacts;
  /**
   * A checkpoint was recorded. The table must drop every seat's CLI
   * conversation: the checkpoint REPLACES the history Squad hands out, and a
   * CLI still holding its own copy would answer from the raw discussion the
   * fold exists to compress. There is no way to tell a CLI to forget.
   */
  readonly onFolded: (teamId: string) => void;
  readonly onChanged: (teamId: string) => void;
  /** A fold or a revoke is a decision about the team: it goes in the team's audit. */
  readonly onAudit?:
    ((teamId: string, kind: "checkpoint-folded" | "checkpoint-revoked", detail: string) => void) | undefined;
}

const newCheckpointId = (): string => `cp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The log, as the 2.x pure functions read it: speech entries plus checkpoints. */
function asStream(events: readonly TeamLogEvent[], hostDisplayName: string): readonly SelectableEvent[] {
  const transcript: TranscriptEntry[] = spokenLines(events, hostDisplayName).map((line) => ({
    kind: SPEECH_KIND,
    text: `【${line.speaker}】${line.text}`,
    turnId: line.entryId,
  }));
  return mergeCheckpoints(transcript, checkpointsOf(events));
}

function checkpointsOf(events: readonly TeamLogEvent[]): readonly MergeableCheckpoint[] {
  const revokedAt = new Map<string, number>();
  for (const event of events) if (event.type === "checkpoint/revoked") revokedAt.set(event.checkpointId, event.at);
  return events.flatMap((event): MergeableCheckpoint[] =>
    event.type === "checkpoint/recorded"
      ? [
          {
            checkpointId: event.checkpointId,
            text: event.text,
            coversUpTo: event.coversUpTo,
            // `seq` breaks ties for checkpoints written in the same millisecond.
            createdAt: event.at + event.seq / 1e6,
            revokedAt: revokedAt.get(event.checkpointId),
          },
        ]
      : [],
  );
}

const textOf = (event: SelectableEvent): string => (typeof event.text === "string" ? event.text : "");

export function createContext(deps: ContextDeps): TeamContext {
  const { store, secretary, facts } = deps;
  const folding = new Set<string>();
  const failures = new Map<string, string>();

  const events = (teamId: string): readonly TeamLogEvent[] => store.logFor(teamId).read();
  const stream = (teamId: string): readonly SelectableEvent[] =>
    asStream(events(teamId), facts(teamId).hostDisplayName);
  const sinceLastCheckpoint = (teamId: string): readonly SelectableEvent[] =>
    selectContextEvents(stream(teamId)).filter((event) => event.kind !== CHECKPOINT_KIND);
  const live = (teamId: string): CheckpointRecordedEvent | undefined => {
    const all = events(teamId);
    const revoked = new Set(all.flatMap((event) => (event.type === "checkpoint/revoked" ? [event.checkpointId] : [])));
    return all
      .filter(
        (event): event is CheckpointRecordedEvent =>
          event.type === "checkpoint/recorded" && !revoked.has(event.checkpointId),
      )
      .at(-1);
  };

  const progress = (teamId: string): ThresholdDecision => {
    const team = facts(teamId);
    return evaluateThreshold({
      contents: sinceLastCheckpoint(teamId).map((event) => ({ text: textOf(event) })),
      coefficient: team.checkpointCoefficient,
      checkpointInFlight: folding.has(teamId),
      teamBusy: team.busy,
    });
  };

  const fold = async (teamId: string): Promise<CheckpointRecordedEvent> => {
    const team = facts(teamId);
    if (folding.has(teamId)) throw new Error("这支团队正在折叠中。");
    folding.add(teamId);
    deps.onChanged(teamId);
    try {
      const plan = planFold(sinceLastCheckpoint(teamId), live(teamId)?.text, team.openCommandIds);
      if (plan === undefined) throw new Error("还没有可以折叠的讨论。");
      const text = await secretary.writeCheckpoint({
        cwd: team.projectFolder,
        seat: team.secretary,
        hostGoal: team.displayName,
        previousCheckpoint: plan.previousCheckpoint,
        turns: plan.turns,
        // Supplied by the program, never left to the transcript. Empty until
        // the agenda writes files (phase 4) — and an empty list is the honest
        // value, because the secretary otherwise invents plausible paths.
        artifactPaths: [],
      });
      const recorded = store.logFor(teamId).append({
        type: "checkpoint/recorded",
        checkpointId: newCheckpointId(),
        text,
        coversUpTo: plan.coversUpTo,
      }) as CheckpointRecordedEvent;
      failures.delete(teamId);
      deps.onAudit?.(
        teamId,
        "checkpoint-folded",
        `${team.secretary.displayName} 把 ${plan.turns.length} 条讨论折叠成检查点。`,
      );
      deps.onFolded(teamId);
      return recorded;
    } finally {
      folding.delete(teamId);
      deps.onChanged(teamId);
    }
  };

  /** Run a fold nobody is waiting on, and keep its failure where it will be seen. */
  const foldInBackground = async (teamId: string, why: string): Promise<void> => {
    try {
      await fold(teamId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.set(teamId, `${why}失败：${detail}`);
      console.warn(`团队 ${teamId}：${why}失败：${detail}`);
      deps.onChanged(teamId);
    }
  };

  return {
    windowFor: (teamId, options = {}) => {
      const selected = selectContextEvents(stream(teamId));
      const continuingAs = options.continuingAs ?? "";
      const tail =
        continuingAs === ""
          ? selected
          : options.seenUpTo === undefined
            ? tailForSeat(selected, continuingAs)
            : tailSince(selected, options.seenUpTo, continuingAs);
      const exclude = new Set(options.exclude ?? []);
      return renderTimeline(exclude.size === 0 ? tail : tail.filter((event) => !exclude.has(String(event.turnId))));
    },

    state: (teamId) => {
      const current = live(teamId);
      const all = events(teamId);
      const revoked = new Set(
        all.flatMap((event) => (event.type === "checkpoint/revoked" ? [event.checkpointId] : [])),
      );
      const failure = failures.get(teamId);
      return {
        ...progress(teamId),
        // Asked directly, not read off `holdReason`: below-threshold wins
        // there, so a manual fold under the limit would read as "not folding".
        folding: folding.has(teamId),
        ...(current === undefined
          ? {}
          : { checkpoint: { checkpointId: current.checkpointId, text: current.text, at: current.at } }),
        history: all
          .filter((event): event is CheckpointRecordedEvent => event.type === "checkpoint/recorded")
          .map((event) => ({
            checkpointId: event.checkpointId,
            at: event.at,
            revoked: revoked.has(event.checkpointId),
          }))
          .reverse(),
        ...(failure === undefined ? {} : { lastFailure: failure }),
      };
    },

    fold,

    revoke: (teamId, checkpointId) => {
      const all = events(teamId);
      const found = all.find((event) => event.type === "checkpoint/recorded" && event.checkpointId === checkpointId);
      if (found === undefined) throw new Error("这支团队没有这个检查点。");
      if (all.some((event) => event.type === "checkpoint/revoked" && event.checkpointId === checkpointId)) return;
      store.logFor(teamId).append({ type: "checkpoint/revoked", checkpointId });
      deps.onAudit?.(teamId, "checkpoint-revoked", "作废一个检查点：它代替的原文重新进入上下文。");
      // The history the checkpoint stood in for comes back into every window,
      // and a conversation that was folded is no longer what the seats should
      // continue from — the same reason a fold drops them.
      deps.onFolded(teamId);
      deps.onChanged(teamId);
    },

    roundEnded: (teamId) => {
      // Not awaited: crossing the threshold must not make the team wait.
      if (progress(teamId).crossed) void foldInBackground(teamId, "自动折叠");
    },

    beforeFreshStart: async (teamId) => {
      if (folding.has(teamId)) return;
      if (
        accumulatedTokens(sinceLastCheckpoint(teamId).map((event) => ({ text: textOf(event) }))) <
        FRESH_START_FOLD_TOKENS
      ) {
        return;
      }
      // A failed fold costs this round a longer window, not the round.
      await foldInBackground(teamId, "新开对话前的折叠");
    },

    compactProjectMemory: async (teamId, file, text) => {
      const facts = deps.facts(teamId);
      try {
        return await secretary.compressProjectMemory({
          cwd: facts.projectFolder,
          seat: facts.secretary,
          file,
          text,
        });
      } catch (error) {
        console.warn(`团队 ${teamId}：秘书没能精简 ${file}：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    },
  };
}

/** The limit a coefficient means, for display. */
export const limitFor = (coefficient: number | undefined): number => thresholdTokensFor(coefficient);
