// 移植自 Squad 2.x packages/seat-dsh/src/argv.ts @ 8dcb903
/**
 * argv.ts — the command line one DSH seat runs on.
 *
 *   dsh --profile <headless profile> <PROMPT>
 *
 * `dsh --profile headless "task"` is the documented one-shot entry point:
 * answer one task, print the final assistant message, exit. Its own `--help`
 * says exactly that, which is why this backend is a CLI seat like the other
 * two rather than something that reaches into the running harness.
 *
 * The profile is configurable because it is the whole configuration surface
 * here: which model a DSH seat runs on is decided by the profile's own model
 * settings, not by a flag this can pass. A deployment that wants a different
 * model for its seats composes a profile for them.
 */

export interface DshArgvInput {
  readonly prompt: string;
  /** The dsh profile to boot. `headless` is the one that answers and exits. */
  readonly profile: string;
  /**
   * A one-shot profile patch, when this seat's connection names a model.
   *
   * Without it the stock profile's own provider answers — DeepSeek's official
   * endpoint — and the connection's endpoint and model are stored, displayed
   * and ignored.
   */
  readonly patchPath?: string | undefined;
}

export function buildDshArgv(input: DshArgvInput): readonly string[] {
  // The prompt goes LAST and is ONE argument. `dsh --profile headless` joins
  // multiple words with spaces, so splitting it here would silently collapse
  // the seat's newlines — and the prompt's structure (the carried discussion,
  // the fence, the round's instruction) is load-bearing.
  const argv = ["--profile", input.profile];
  if (input.patchPath !== undefined && input.patchPath !== "") argv.push("--patch", input.patchPath);
  argv.push(input.prompt);
  return argv;
}
