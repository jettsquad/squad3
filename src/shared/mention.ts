// 移植自 Squad 2.x packages/console/src/mention.ts @ 8dcb903
/**
 * mention.ts — pointing at seats by name inside the instruction.
 *
 * 1.x wrote `@陈六 …` and this project shipped a row of checkboxes instead.
 * The checkboxes are worse for a specific reason: naming someone is part of
 * what you are saying, and splitting it into a separate control means the
 * sentence and its audience are edited in two places and can disagree — you
 * rewrite the question and the ticks stay where they were.
 *
 * Decided against the ACTUAL roster, never by shape. `@` is an ordinary
 * character in prose, and 「联系我 @公司邮箱」 is not a roll-call.
 *
 * Mentions count ANYWHERE in the sentence, which is 1.x's rule
 * (`text.includes("@" + displayName)`) and had been narrowed here to the
 * leading run only. The narrowing was defended as disambiguation — 「问一下
 * @架构 和运维」 might mention a seat as a topic — but the cost was silent and
 * far worse than the case it guarded: 「请 @吴二 复核」 looks addressed to
 * one person and was quietly broadcast to everyone, with nothing on screen
 * saying so. A rule people cannot see is a rule that is wrong.
 *
 * What stays narrow is the STRIPPING. Only a leading roll-call is removed
 * from the instruction, because that is the part that is pure addressing; an
 * `@name` inside a sentence is part of the sentence and cutting it out would
 * hand the seat a mangled question.
 */

export interface Mentions {
  /** The instruction with the leading roll-call removed. */
  readonly instruction: string;
  /** Display names that were called on. Empty means everyone. */
  readonly named: readonly string[];
  /** `@` tokens that match no seat, in the order they appeared. */
  readonly unknown: readonly string[];
}

/**
 * Every `@name` in the text that is a boundary-terminated seat name.
 *
 * Longest first at each `@`, so 「@架构组」 is not read as 「@架构」 plus a
 * stray 组 — the same rule the leading pass uses, applied to the whole string.
 */
function mentionsAnywhere(raw: string, seatNames: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (let index = raw.indexOf("@"); index >= 0; index = raw.indexOf("@", index + 1)) {
    const tail = raw.slice(index + 1);
    const match = seatNames
      .filter((name) => {
        if (!tail.startsWith(name)) return false;
        const after = tail.charAt(name.length);
        return after === "" || /[\s,，、:：。！？!?;；]/.test(after);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (match !== undefined && !found.includes(match)) found.push(match);
  }
  return found;
}

/**
 * Read `@name` tokens off an instruction.
 *
 * Two passes with different jobs. The leading one decides what to REMOVE — a
 * roll-call in front of the question is addressing, not content. The whole-text
 * one decides who is ASKED, because that is what a person means by writing a
 * name, wherever they wrote it.
 */
export function parseMentions(raw: string, seatNames: readonly string[]): Mentions {
  const named: string[] = [];
  const unknown: string[] = [];
  let rest = raw.trimStart();

  /** Punctuation between one mention and the next, or before the instruction. */
  const eatSeparators = (): void => {
    rest = rest.replace(/^[,，、:：]+\s*/, "").trimStart();
  };

  for (;;) {
    if (!rest.startsWith("@")) break;
    // A seat name only matches up to a BOUNDARY. Without that, `@架构师`
    // matches the seat 架构 and leaves 「师 看看」 as the instruction — the
    // question goes to the wrong person and the leftover character rides
    // along inside it.
    const match = seatNames
      .filter((name) => {
        if (!rest.startsWith(`@${name}`)) return false;
        const after = rest.charAt(name.length + 1);
        return after === "" || /[\s,，、:：]/.test(after);
      })
      // Longest first, so 「@架构组」 is not read as 「@架构」 plus a stray 组.
      .sort((a, b) => b.length - a.length)[0];
    if (match !== undefined) {
      if (!named.includes(match)) named.push(match);
      rest = rest.slice(match.length + 1).trimStart();
      eatSeparators();
      continue;
    }
    // An `@` that starts the text but names nobody: reported, not silently
    // treated as prose. A misspelled name would otherwise send the question
    // to the whole team while looking like it was aimed at one person.
    const token = /^@([^\s,，、:：]+)/.exec(rest);
    if (token?.[1] === undefined) break;
    unknown.push(token[1]);
    rest = rest.slice(token[0].length).trimStart();
    eatSeparators();
  }
  // Names further into the sentence are asked too, and appended rather than
  // merged in place so the roll-call's order — the order the person wrote the
  // list in — still leads.
  for (const name of mentionsAnywhere(rest, seatNames)) {
    if (!named.includes(name)) named.push(name);
  }
  // An unknown `@` only counts when it was in the roll-call. Mid-sentence,
  // 「联系我 @公司邮箱」 is prose, and refusing to send it would make the box
  // reject ordinary writing.
  return { instruction: rest, named, unknown };
}

/** An `@` the person is in the middle of typing, and what they have typed. */
export interface MentionDraft {
  /** Index of the `@` itself. */
  readonly at: number;
  /** What follows it, up to the caret. Empty right after typing `@`. */
  readonly typed: string;
}

/**
 * The `@` being typed at the caret, if any — what a name list should offer for.
 *
 * The roster is not consulted here, and the parameter that once carried it is
 * gone: every `@name` in the sentence is now a mention, so there is nowhere a
 * pick would fail to mean something. Which NAMES to offer is
 * `mentionCandidates`, and that is where the roster belongs.
 */
export function mentionDraftAt(raw: string, caret: number): MentionDraft | undefined {
  const head = raw.slice(0, caret);
  const at = head.lastIndexOf("@");
  if (at < 0) return undefined;
  const typed = head.slice(at + 1);
  // A space ends a mention: past it the person is writing the instruction.
  if (/\s/.test(typed)) return undefined;
  // No check on what comes BEFORE the `@`. There used to be one, refusing to
  // offer names mid-sentence — which was correct while only a leading
  // roll-call was honoured and is wrong now that any `@name` is asked. The
  // list appears wherever a pick would do something, which is everywhere.
  return { at, typed };
}

/**
 * The names worth offering for a draft, best match first.
 *
 * Prefix matches before contained ones, so typing the start of a name puts it
 * at the top where Enter will take it.
 */
export function mentionCandidates(draft: MentionDraft, seatNames: readonly string[]): readonly string[] {
  const typed = draft.typed.toLowerCase();
  if (typed === "") return seatNames;
  const prefix = seatNames.filter((name) => name.toLowerCase().startsWith(typed));
  const rest = seatNames.filter((name) => !prefix.includes(name) && name.toLowerCase().includes(typed));
  return [...prefix, ...rest];
}

/**
 * Put a chosen name into the text, and say where the caret goes.
 *
 * A trailing space is part of the completion: without it the next character
 * typed extends the name, and `parseMentions` then reports a seat nobody has.
 */
export function applyMention(
  raw: string,
  caret: number,
  draft: MentionDraft,
  name: string,
): { readonly text: string; readonly caret: number } {
  const inserted = `@${name} `;
  const text = raw.slice(0, draft.at) + inserted + raw.slice(caret);
  return { text, caret: draft.at + inserted.length };
}
