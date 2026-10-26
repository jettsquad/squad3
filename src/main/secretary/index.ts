/**
 * secretary — the one seat allowed to do judgement work for the host.
 *
 * 移植自 Squad 2.x packages/secretary/src/service.ts @ 8dcb903
 * 改动：不再借 dsh 的主持人节点当父 agent、不再按 provider 名找后端。每个任务都是对秘书席位的
 * 一次新开、一次性的调用，经由同一个席位适配器——和团队里任何一个席位跑在同一条路上。
 *
 * Stateless by construction. Every call opens a fresh run and throws it away,
 * and every input is fed in by the caller — a continuation checkpoint carries
 * the previous one in its prompt rather than in any memory here.
 *
 * Nothing here is optional-on-failure. A checkpoint becomes the basis of every
 * later round, so a malformed one is refused, not stored (see tasks.ts).
 */
import { stripReasoning, type AgendaSpec } from "../../shared/index.ts";
import type { SeatSpec } from "../../shared/seat.ts";
import type { ResolvedConnection, Seats } from "../seats/index.ts";
import type { AgendaDraftInput } from "./agenda.ts";
import type { AssistInput } from "./assist.ts";
import type { CheckpointPromptInput } from "./checkpoint.ts";
import type { ProjectMemoryPromptInput } from "./project-memory.ts";
import { personaPlan } from "./persona.ts";
import type { QuietJudgement, QuietJudgementInput } from "./quiet.ts";
import {
  agendaFromReplyWith,
  assistWith,
  compressProjectMemoryWith,
  draftAgendaWith,
  judgeQuietWith,
  writeCheckpointWith,
  writeTerminationWith,
  type TerminationInput,
  type TextTaskRunner,
} from "./tasks.ts";

export { CHECKPOINT_HEADING_LIST, CHECKPOINT_HEADINGS } from "./checkpoint.ts";

/** How one secretary task is run. */
export interface SecretaryRun {
  /** The team's project folder: the secretary reads and writes where the team works. */
  readonly cwd: string;
  /**
   * The designated secretary seat, whole — its standing instructions AND the
   * backend it runs on. One field, because passing them separately is how 2.x
   * broke: the persona was passed, the provider forgotten, and the secretary's
   * model configuration was stored, shown, and ignored.
   */
  readonly seat: SeatSpec;
  readonly signal?: AbortSignal | undefined;
}

export interface Secretary {
  writeCheckpoint(input: CheckpointPromptInput & SecretaryRun): Promise<string>;
  writeTermination(input: TerminationInput & SecretaryRun): Promise<string>;
  assist(input: AssistInput & SecretaryRun): Promise<string>;
  /** Rewrite an outgrown project file; returns the body. */
  compressProjectMemory(input: ProjectMemoryPromptInput & SecretaryRun): Promise<string>;
  draftAgenda(input: AgendaDraftInput & SecretaryRun): Promise<AgendaSpec>;
  agendaFromReply(input: AgendaDraftInput & SecretaryRun & { readonly reply: string }): Promise<AgendaSpec>;
  /** Whether a quiet command should be waited for. Throws only when the secretary could not be run. */
  judgeQuiet(
    input: QuietJudgementInput & Omit<SecretaryRun, "seat"> & { readonly secretary: SeatSpec },
  ): Promise<QuietJudgement>;
}

/**
 * The seat that does the secretary's work when the team named none.
 *
 * The host's own Claude Code login, no standing instructions: the same thing
 * 2.x fell back to (its default fenced provider).
 */
export const DEFAULT_SECRETARY: SeatSpec = {
  seatId: "secretary",
  displayName: "秘书",
  role: "秘书",
  systemPrompt: "",
  backend: "claude-code",
};

export function createSecretary(
  seats: Seats,
  options: {
    /**
     * The secretary seat's connection, looked up at each task like any seat's.
     * Without it a secretary on an API-key connection would run on the host's
     * own login — configured, shown, and ignored.
     */
    readonly connectionFor?: ((seat: SeatSpec) => ResolvedConnection | undefined) | undefined;
  } = {},
): Secretary {
  const runner =
    (run: SecretaryRun): TextTaskRunner =>
    async (_label, prompt) => {
      const adapter = seats.adapterFor(run.seat.backend);
      if (typeof adapter === "string") return { text: adapter, stopReason: "error" };
      let connection: ResolvedConnection | undefined;
      try {
        connection = options.connectionFor?.(run.seat);
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), stopReason: "error" };
      }
      // Asked, not assumed: a backend that takes a task and nothing else gets
      // the standing instructions folded into the task, labelled.
      const plan = personaPlan({
        persona: run.seat.systemPrompt,
        prompt,
        supported: adapter.capabilities.persona,
      });
      const result = await adapter.start({
        seat: run.seat,
        ...(connection === undefined ? {} : { connection }),
        cwd: run.cwd,
        prompt: plan.prompt,
        ...(plan.persona === undefined ? {} : { persona: plan.persona }),
        ...(run.signal === undefined ? {} : { signal: run.signal }),
      }).result;
      // Only a completed run is an answer (tasks.ts refuses everything else),
      // and the text travels with the refusal as the only evidence there is.
      const stopReason = result.cancelled ? "aborted" : result.failed ? "error" : "completed";
      return { text: stripReasoning(result.text), stopReason };
    };

  return {
    writeCheckpoint: (input) => writeCheckpointWith(runner(input), input),
    writeTermination: (input) => writeTerminationWith(runner(input), input),
    assist: (input) => assistWith(runner(input), input),
    compressProjectMemory: (input) => compressProjectMemoryWith(runner(input), input),
    draftAgenda: (input) => draftAgendaWith(runner(input), input),
    agendaFromReply: (input) => agendaFromReplyWith(runner(input), input),
    // `seat` already names the quiet seat in the judgement; the secretary comes separately.
    judgeQuiet: ({ secretary, ...input }) => judgeQuietWith(runner({ ...input, seat: secretary }), input),
  };
}
