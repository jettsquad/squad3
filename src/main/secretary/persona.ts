// 移植自 Squad 2.x packages/secretary/src/persona.ts @ 8dcb903
/**
 * persona.ts — giving a seat its standing instructions when the seam cannot.
 *
 * `SubagentStartRequest.persona` is a CAPABILITY, and only the Claude Code
 * backend declares it. Codex and dsh declare `persona: false` truthfully —
 * `codex exec` and `dsh --profile headless` take a task and nothing else —
 * and the seam then REFUSES a request carrying one rather than accepting it
 * and quietly dropping it. That refusal is correct and it is the reason this
 * file exists: every secretary task passed the seat's system prompt as
 * `persona`, so a team whose secretary ran on dsh or codex could not draft an
 * agenda, write a checkpoint, or do anything else at all. The error named a
 * capability, which reads as an internal detail, so from the outside the
 * secretary simply had no abilities.
 *
 * The fix is not to drop the persona — the standing instructions are half of
 * why that seat was chosen as secretary. It is to put them where a prompt-only
 * backend can still read them: at the top of the prompt, labelled, so the
 * model can tell its own standing instructions from the job at hand.
 */

/** The marker that separates who you are from what you are being asked. */
const PERSONA_HEADING = "## 你的身份与固定要求";
const TASK_HEADING = "## 本次任务";

/**
 * Fold standing instructions into a prompt.
 *
 * Labelled rather than concatenated: a persona pasted straight onto a task
 * reads as part of the task, and a secretary told 「你说话要简短」 would
 * summarise the instruction instead of following it.
 *
 * An empty persona returns the prompt untouched, so this is safe to call
 * unconditionally.
 */
export function foldPersona(persona: string | undefined, prompt: string): string {
  const standing = (persona ?? "").trim();
  if (standing === "") return prompt;
  return [PERSONA_HEADING, standing, "", TASK_HEADING, prompt].join("\n");
}

/**
 * How one task should carry its persona, given what the provider supports.
 *
 * Returned as data rather than applied here so the decision can be tested
 * without a subagent registry — and so the call site reads as a choice
 * between two supported paths rather than a try/catch around a refusal.
 */
export function personaPlan(input: {
  readonly persona: string | undefined;
  readonly prompt: string;
  /** Whether the chosen provider declares the `persona` capability. */
  readonly supported: boolean;
}): { readonly prompt: string; readonly persona?: string } {
  const standing = (input.persona ?? "").trim();
  if (standing === "") return { prompt: input.prompt };
  return input.supported
    ? { prompt: input.prompt, persona: standing }
    : { prompt: foldPersona(standing, input.prompt) };
}
