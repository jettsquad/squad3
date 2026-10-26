// 移植自 Squad 2.x packages/shared/src/speakable.ts @ 8e96d9c
/**
 * speakable.ts — turning a seat's reply into something worth hearing.
 *
 * Reading a reply aloud verbatim does not work, and the reasons are all
 * structural rather than cosmetic. A seat's answer is written to be SCANNED:
 * headings you skip past, a table you read down one column of, a code block
 * you look at only if the prose above made you care. Speech is linear — you
 * cannot skim it — so every one of those becomes a minute of listening to
 * punctuation being pronounced.
 *
 * So this is not a Markdown renderer with the tags removed. It decides what
 * survives contact with an ear: prose survives, structure is announced rather
 * than spelled out, and code is named rather than read. 「这里有一段代码」 is
 * more use than forty seconds of `const`, and the text is still on screen for
 * anyone who wants the real thing.
 */

/** What a chunk of speech is capped at. MiniMax takes 10k; short starts sooner. */
export const SPEECH_CHUNK_CHARS = 600;

/**
 * Greek letters, as the names an English speaker says.
 *
 * Both directions matter: a reply may carry the glyph (α) or the LaTeX name
 * (\alpha), and the two must land on the same word.
 */
const GREEK: Readonly<Record<string, string>> = {
  α: "alpha",
  β: "beta",
  γ: "gamma",
  δ: "delta",
  ε: "epsilon",
  ζ: "zeta",
  η: "eta",
  θ: "theta",
  ι: "iota",
  κ: "kappa",
  λ: "lambda",
  μ: "mu",
  ν: "nu",
  ξ: "xi",
  π: "pi",
  ρ: "rho",
  σ: "sigma",
  τ: "tau",
  υ: "upsilon",
  φ: "phi",
  χ: "chi",
  ψ: "psi",
  ω: "omega",
  Γ: "Gamma",
  Δ: "Delta",
  Θ: "Theta",
  Λ: "Lambda",
  Ξ: "Xi",
  Π: "Pi",
  Σ: "Sigma",
  Φ: "Phi",
  Ψ: "Psi",
  Ω: "Omega",
};

/** Operators and relations, as words rather than glyphs. */
const OPERATORS: readonly (readonly [RegExp, string])[] = [
  [/\\(?:times|cdot)\b/g, " times "],
  [/\\div\b/g, " divided by "],
  [/\\pm\b/g, " plus or minus "],
  [/\\leq\b|\\le\b|≤/g, " less than or equal to "],
  [/\\geq\b|\\ge\b|≥/g, " greater than or equal to "],
  [/\\neq\b|\\ne\b|≠/g, " not equal to "],
  [/\\approx\b|≈/g, " approximately "],
  [/\\infty\b|∞/g, " infinity "],
  [/\\rightarrow\b|\\to\b|→/g, " goes to "],
  [/×/g, " times "],
  [/÷/g, " divided by "],
  [/±/g, " plus or minus "],
];

/**
 * One formula, as English words.
 *
 * The reason this exists at all: a formula that reaches the synthesiser as
 * `$v_{\max}$` is READ as its characters — dollar, backslash, braces — and
 * the letters between them arrive as isolated Latin glyphs in a Chinese
 * sentence, which is what the language detector was guessing German from.
 * Turning the whole thing into words removes both problems at once: there is
 * nothing left to mispronounce, and what remains is unambiguously English.
 *
 * Deliberately not a LaTeX engine. It covers what appears in a discussion —
 * fractions, subscripts, powers, roots, the common operators — and anything
 * it does not know loses its backslash and is read as the word it already
 * is, which for `\gamma` or `\sum` is the right answer anyway.
 */
export function spokenMath(latex: string): string {
  let out = latex;

  // Fractions first: the braces are the argument boundaries, and every rule
  // below would eat them.
  for (let i = 0; i < 3 && /\\[dt]?frac/.test(out); i += 1) {
    out = out.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " ($1) over ($2) ");
  }
  out = out.replace(/\\sqrt\s*\{([^{}]*)\}/g, " square root of ($1) ");

  // Powers, with names for the two that have them.
  out = out.replace(/\^\s*\{?\s*2\s*\}?/g, " squared ");
  out = out.replace(/\^\s*\{?\s*3\s*\}?/g, " cubed ");
  out = out.replace(/\^\s*\{([^{}]*)\}/g, " to the power of $1 ");
  out = out.replace(/\^\s*(\w+)/g, " to the power of $1 ");
  // Subscripts. "sub" is what a person says when reading one aloud.
  out = out.replace(/_\s*\{([^{}]*)\}/g, " sub $1 ");
  out = out.replace(/_\s*(\w+)/g, " sub $1 ");

  for (const [pattern, word] of OPERATORS) out = out.replace(pattern, word);

  // Named things that survive as their own word once the backslash is gone:
  // \sum, \int, \gamma, \sigma all read correctly as text.
  out = out.replace(/\\(?:left|right|,|;|!|quad|qquad)/g, " ");
  out = out.replace(/\\([A-Za-z]+)/g, " $1 ");

  out = out.replace(/[{}]/g, " ");
  out = out.replace(/\s*=\s*/g, " equals ");
  out = out.replace(/\s*\+\s*/g, " plus ");
  // Only a binary minus. A leading one is 「negative」 and reads fine as the
  // glyph, and hyphenated words must not be torn apart.
  out = out.replace(/(\w)\s*-\s*(?=[\w\\(])/g, "$1 minus ");

  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * One reply, as text to be spoken.
 *
 * Order matters: fenced code goes first, before anything else can mangle the
 * text inside it, and inline formatting goes last, after the block structures
 * that would otherwise be read as literal characters.
 */
export function speakableText(markdown: string): string {
  let text = markdown;

  // Fenced code, named not read. A listener wants to know it is there.
  text = text.replace(/```[\s\S]*?```/g, "。这里有一段代码，略过。");
  // Inline code keeps its content — it is usually one identifier, and saying
  // 「反引号 seatId 反引号」 would be worse than saying `seatId`.
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // Formulas, before anything below can take their braces and underscores
  // apart. Display first: `$$…$$` has to match before `$…$` can, or the
  // opening pair is read as one empty inline formula.
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, body: string) => ` ${spokenMath(body)} `);
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => ` ${spokenMath(body)} `);
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => ` ${spokenMath(body)} `);
  // Inline `$…$`, but not a price: `$5` and `100$` carry no closing pair with
  // maths in it, and treating them as formulas would eat the sentence between
  // two unrelated dollar signs.
  text = text.replace(/\$([^$\n]+?)\$/g, (whole: string, body: string) =>
    /[\\^_{}=+/]|[A-Za-z]/.test(body) ? ` ${spokenMath(body)} ` : whole,
  );

  // Greek glyphs outside any formula — plenty of replies write σ inline
  // without marking it up, and an unnamed glyph is exactly the isolated
  // character the language detector was guessing from.
  text = text.replace(/[α-ωΑ-Ω]/g, (glyph: string) => GREEK[glyph] ?? glyph);

  // Tables: announced with their size rather than read cell by cell. Reading
  // a table aloud produces a stream of words with no structure at all, which
  // is the one thing a table exists to provide.
  text = text.replace(/(?:^\|.*\|[ \t]*$\n?){2,}/gm, (block) => {
    const rows = block.trim().split("\n").length;
    // The separator row is not data, and neither is the header.
    const body = Math.max(0, rows - 2);
    return `。这里有一个表格，${body} 行，略过。\n`;
  });

  // Headings become spoken transitions. Dropping them entirely loses the
  // shape of the answer; reading the hashes is nonsense.
  text = text.replace(/^#{1,6}\s*(.+)$/gm, "。$1。");
  // Blockquote and list markers: the marker is layout, the text is content.
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "、");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "、");
  // Horizontal rules say nothing out loud.
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, "");

  // Links: the label is what a person would say; the URL never is.
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  // Emphasis markers, once the block structures above are gone.
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n")
    .replace(/。{2,}/g, "。")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Split spoken text into chunks that can be synthesised one at a time.
 *
 * Chunked because the first chunk is what decides whether this feels usable:
 * a whole reply sent as one request is one wait before any sound, and a long
 * answer would be tens of seconds of silence that looks exactly like a
 * feature that does not work. It also makes 「跳过这一位」 cheap — nothing
 * further has been synthesised yet.
 *
 * Split on sentence ends rather than at a character count, because a cut
 * mid-clause is audible and sounds like a fault.
 */
export function speechChunks(text: string, maxChars = SPEECH_CHUNK_CHARS): readonly string[] {
  const clean = text.trim();
  if (clean === "") return [];
  const pieces = clean.split(/(?<=[。！？!?；;\n])/);
  const chunks: string[] = [];
  let held = "";
  for (const piece of pieces) {
    if (held !== "" && held.length + piece.length > maxChars) {
      chunks.push(held.trim());
      held = "";
    }
    // A single sentence longer than the cap is not split further: a hard cut
    // inside a clause is worse than one chunk that runs long, and the model
    // takes far more than this anyway.
    held += piece;
  }
  if (held.trim() !== "") chunks.push(held.trim());
  return chunks.filter((chunk) => chunk !== "");
}

/**
 * The credential a connection's environment carries.
 *
 * Which variable it lands in depends on the backend and, for Claude Code, on
 * the auth header — so a caller that needs the secret itself (the speech
 * route does) would otherwise have to re-derive that rule and get it wrong
 * for one of the cases.
 */
export function credentialFrom(env: Readonly<Record<string, string>>): string | undefined {
  for (const name of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "CODEX_API_KEY"]) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}
