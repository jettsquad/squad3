// 移植自 Squad 2.x packages/shared/src/host-name.ts @ 8dcb903
/**
 * host-name.ts — what seats call the person at the table.
 *
 * Here rather than in the settings service because two sides need the same
 * answer and must not each invent one: the service resolves it when a team is
 * created, and any screen showing 「还没设过」 has to agree about what counts
 * as unset. A second copy of this rule would be the kind of disagreement that
 * shows up as a prompt saying 「主持人：」 with nothing after it.
 */

/** The name a table falls back to when nobody has said otherwise. */
export const DEFAULT_HOST_NAME = "主持人";

/**
 * The name to use, always a usable one.
 *
 * Blank is treated as unset rather than as a name. It would otherwise reach a
 * seat's prompt as a heading with an empty value, which a model reads as a
 * broken field rather than as a person — so emptying the box means "use the
 * default", not "have no name".
 */
export function hostNameOrDefault(stored: string | undefined): string {
  const trimmed = stored?.trim();
  return trimmed === undefined || trimmed === "" ? DEFAULT_HOST_NAME : trimmed;
}
