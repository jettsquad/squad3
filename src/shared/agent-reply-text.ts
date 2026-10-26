/**
 * agent-reply-text.ts — a reply is what the agent said, not how it got there.
 *
 * 移植自 Squad 2.x packages/shared/src/agent-reply-text.ts @ 8dcb903（无改动）
 *
 * Several backends emit their reasoning inline: DeepSeek-lineage models wrap
 * it in `<think>` tags and the harness hands us stdout verbatim, and any
 * model reached through the plain-completion fallback can do the same. That
 * text then became a transcript message — read by the host, carried into
 * every later turn's context, and folded into checkpoints.
 *
 * It is stripped rather than shown. Reasoning is long, it is the model
 * talking to itself, and it crowds out the answer for every reader
 * downstream — human and agent alike.
 *
 * Claude Code and Codex are already clean by construction (their stream
 * parsers keep only text / agent_message blocks), so this exists for the
 * harnesses that hand back raw text.
 */

/** Tag pairs that carry reasoning rather than an answer. */
const REASONING_TAGS = ["think", "thinking", "thought", "reasoning"] as const;

const closedBlock = (tag: string): RegExp => new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");

/** An opening tag whose close never arrived — the turn was cut off mid-thought. */
const danglingOpen = (tag: string): RegExp => new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*$`, "i");

/** Shown when a turn produced reasoning and never got to an answer. */
export const REASONING_ONLY_NOTICE = "（该回合只输出了思考过程，没有给出答复。）";

/**
 * Remove inline reasoning from a reply.
 *
 * A dangling open tag takes everything after it: the model was still
 * thinking when the turn ended, so nothing after it is an answer.
 *
 * When that leaves nothing, the reply becomes a one-line notice rather than
 * either an empty string or the raw thought. Empty would be
 * indistinguishable from a silent failure; the raw thought is exactly what
 * this function exists to keep out of the transcript, out of every later
 * turn's context, and out of checkpoints.
 */
export const stripReasoning = (text: string): string => {
  let out = text;
  for (const tag of REASONING_TAGS) out = out.replace(closedBlock(tag), "");
  for (const tag of REASONING_TAGS) out = out.replace(danglingOpen(tag), "");
  const trimmed = out.replace(/\n{3,}/g, "\n\n").trim();
  if (trimmed !== "") return trimmed;
  return text.trim() === "" ? text.trim() : REASONING_ONLY_NOTICE;
};
