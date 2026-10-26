// 移植自 Squad 2.x packages/context/src/timeline.ts @ 8dcb903
// 改动：IGNORED / FORBIDDEN 两张表原本列的是 dsh 会话日志的事件类型。3 的团队日志是自己的、
// 词汇是闭合的（shared/team-log.ts），装配层只会看到发言、检查点和作废标记三种；也没有
// 「主持人节点」这个会跑回合的 agent，所以 FORBIDDEN 表随之消失。「不认识就抛错」这条原样保留。
/**
 * timeline.ts — turning selected events into the lines a seat reads.
 *
 * The second of assembly's two layers. `window.ts` decided WHICH events
 * travel; this decides HOW they read. In 1.x the two layers kept separate
 * event lists and disagreed: this one ended in a catch-all that returned
 * nothing for any kind it had not been taught, and the context checkpoint
 * fell through it. The window had correctly cut history off at the
 * checkpoint, and then the checkpoint itself never reached the model.
 * History gone, replacement gone, no error anywhere.
 *
 * So there is no catch-all. Every kind is either rendered or deliberately
 * ignored, and a kind in neither throws at the moment it is introduced.
 */
import { stripReasoning } from "../../shared/index.ts";
import { CHECKPOINT_KIND, CHECKPOINT_REVOKED_KIND, type SelectableEvent } from "./window.ts";

/** The kind the context layer gives one line of the discussion. */
export const SPEECH_KIND = "user/message";

/**
 * Says what the checkpoint is, in the prompt itself. Without this line a
 * checkpoint reads as somebody's opinion; with it, a seat knows the earlier
 * detail still exists and can be asked for.
 */
export const CHECKPOINT_TIMELINE_PREFIX =
  "【上下文检查点】以下是此前讨论的要点。需要原文时，可以请主持人引用相应发言。";

/**
 * Kinds that carry nothing a seat should read.
 *
 * `checkpointRevoked` is here because the window layer has already consumed
 * it: by the time an event list reaches this layer, a revoked checkpoint is
 * gone and the marker itself has no reader.
 */
export const TIMELINE_IGNORED_KINDS: ReadonlySet<string> = new Set([CHECKPOINT_REVOKED_KIND]);

const asString = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

/** Render one selected event, or `undefined` when the kind is deliberately not shown. Throws on any other kind. */
export const renderTimelineEvent = (event: SelectableEvent): string | undefined => {
  switch (event.kind) {
    case SPEECH_KIND:
      // Stripped again here, not only where the reply was produced: the log
      // keeps what was recorded, and turns recorded before replies were
      // cleaned would otherwise go on feeding their reasoning to a seat.
      return stripReasoning(asString(event.text ?? event.message, ""));
    case CHECKPOINT_KIND:
      return `${CHECKPOINT_TIMELINE_PREFIX}\n\n${asString(event.text ?? event.message, "")}`;
    default:
      if (TIMELINE_IGNORED_KINDS.has(event.kind)) return undefined;
      throw new Error(
        `装配层遇到未知事件类型「${event.kind}」。` +
          `请把它加入 TIMELINE_IGNORED_KINDS，或为它写一个渲染分支——` +
          `静默丢弃会让席位看不见本该看见的内容，而且不报错。`,
      );
  }
};

/** Render a whole window in transcript order, dropping only the ignored kinds. */
export const renderTimeline = (events: readonly SelectableEvent[]): readonly string[] =>
  events.flatMap((event) => {
    const line = renderTimelineEvent(event);
    return line === undefined ? [] : [line];
  });
