// 移植自 Squad 2.x packages/secretary/src/checkpoint.ts @ 8dcb903
/**
 * team-checkpoint.ts — the context checkpoint: a navigation document.
 *
 * A checkpoint is NOT the same thing as a summary the host asks an agent
 * for. That is a work product: it lands in the transcript as an ordinary
 * reply and changes nothing about what later turns are shown. A checkpoint
 * is a control artifact: once recorded, earlier turns stop being carried
 * into context. The two are kept apart by event kind so neither can be
 * mistaken for the other.
 *
 * It navigates rather than compresses. Replies are not squeezed into a
 * shorter retelling — the checkpoint states what was decided, what is still
 * open, and where the detail lives, so a later turn can go read the
 * original when it needs it. Compression loses; an index does not.
 *
 * Disagreement is first-class. Flattening three positions into "the team
 * decided X" destroys the minority views permanently, and nobody
 * downstream can tell it happened. Open disagreements stay listed, and
 * each new checkpoint re-adjudicates them: settled ones close, live ones
 * carry, new ones join.
 */

/** The fixed headings. Fixed so an assembler can take a section without parsing prose. */
export const CHECKPOINT_HEADINGS = {
  goal: "## 当前目标",
  settled: "## 已定事项",
  open: "## 未决分歧",
  index: "## 产出索引",
} as const;

export const CHECKPOINT_HEADING_LIST: readonly string[] = Object.values(CHECKPOINT_HEADINGS);

/** One recorded turn, as the checkpoint prompt sees it. */
export interface CheckpointSourceTurn {
  readonly speaker: string;
  readonly text: string;
}

export interface CheckpointPromptInput {
  readonly hostGoal: string;
  /** The checkpoint this one supersedes, when the team has one. */
  readonly previousCheckpoint?: string | undefined;
  /** Turns since that checkpoint — or the whole discussion for the first one. */
  readonly turns: readonly CheckpointSourceTurn[];
  /**
   * Files this team has actually written, supplied by the program.
   *
   * Without them the secretary has only the transcript to go on and will
   * invent plausible paths for the index — and an invented path is worse
   * than no index at all, because an agent follows it and finds nothing.
   */
  readonly artifactPaths?: readonly string[] | undefined;
  /**
   * The host's own standards that bear on writing this, already selected.
   *
   * Passed in rather than fetched: the criteria library is user-level and
   * this file knows nothing about it, which is also what keeps it off the
   * path to a discussion seat.
   *
   * A checkpoint is where they matter most. Folding decides what survives
   * into the only history later agents will see, and 「不要把分歧写成共识」
   * is exactly the kind of standard that is easy to state and easy to lose
   * under summarising pressure.
   */
  readonly criteria?: string | undefined;
}

const INSTRUCTIONS = `你在为一个 AI 协作团队写「上下文检查点」。它不是给人看的汇报，而是后续 agent 唯一能看到的历史。

写作要求：
- 严格使用下列四个标题，顺序不变，不要增删标题。
- 已定事项：写结论，不写过程。每条独立成立，读者没有上下文也能懂。
- 未决分歧：**不要把分歧写成共识**。有几种立场就列几种，注明各自是谁、理由是什么。这是本文档最重要的部分。
- 产出索引：只列下方「已写入的文件」中给出的路径，**不要自己编造路径**。每条附一句话说明里面写了什么，好让后续 agent 不打开文件也能判断要不要读。没有文件就写「无」。
- 不要复述原文，不要写客套话，不要评价团队表现。`;

const CONTINUATION_INSTRUCTIONS = `这是一次**接续**检查点，上一份检查点在下方。

- 已定事项：直接继承上一份的条目（它们已经是结论，不要重新概括，否则每次都会再失真一层），再并入这期间新达成的。
- 未决分歧：**逐条重新裁定**上一份列出的分歧 —— 已解决的移出并写进「已定事项」，仍未决的保留，新出现的加入。它是一份活的清单，不是流水账。
- 当前目标：如果主持人后来改了方向，以最新为准。`;

/**
 * Build the instruction for the secretary. Continuation checkpoints take the
 * previous one as INPUT rather than as raw material: re-summarising an
 * already-summarised document compounds its losses every time.
 */
export const buildCheckpointPrompt = (input: CheckpointPromptInput): string => {
  const transcript = input.turns.map((turn) => `【${turn.speaker}】${turn.text}`).join("\n\n");
  const heading = CHECKPOINT_HEADING_LIST.join("\n");
  const paths = input.artifactPaths ?? [];
  return [
    INSTRUCTIONS,
    input.previousCheckpoint === undefined ? "" : CONTINUATION_INSTRUCTIONS,
    // Before the material, after the instructions: they qualify HOW to write
    // this, and a standard placed after the transcript reads as a comment on
    // the transcript.
    input.criteria === undefined || input.criteria.trim() === ""
      ? ""
      : `主持人自己定下的判断标准，写这份检查点时按它们来：\n${input.criteria}`,
    `团队目标：${input.hostGoal}`,
    input.previousCheckpoint === undefined ? "" : `上一份检查点：\n${input.previousCheckpoint}`,
    `需要纳入的讨论内容：\n${transcript || "（无新增讨论）"}`,
    `已写入的文件（产出索引只能用这些路径）：\n${
      paths.length === 0 ? "（无）" : paths.map((path) => `- ${path}`).join("\n")
    }`,
    `输出格式（四个标题必须齐全）：\n${heading}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
};

export type CheckpointValidation = { readonly ok: true } | { readonly ok: false; readonly missing: readonly string[] };

/**
 * A heading LINE naming this section, at any level.
 *
 * The four sections are siblings and nothing reads them by level: the
 * checkpoint travels into later windows whole. `##` is a convention, and
 * holding a model to it exactly cost a real fold — a secretary that opened
 * with `# 当前目标` had a complete checkpoint thrown away over one `#`. The
 * old check was a substring match, which let `###` through by accident and
 * refused `#`; it never enforced a level, only happened to refuse one.
 *
 * A line, not a mention: 「当前目标」 inside a sentence is not the section.
 */
const headingLine = (heading: string): RegExp =>
  new RegExp(`^#{1,6}[ \t]+${heading.replace(/^#+\s*/, "")}[ \t]*#*[ \t]*\r?$`, "gm");

/**
 * A checkpoint becomes the basis of every later turn, so a malformed one is
 * not a cosmetic problem — it silently degrades everything downstream.
 * Missing sections are reported rather than accepted; what is lenient is
 * only how many `#` a section heading carries.
 */
export const validateCheckpoint = (text: string): CheckpointValidation => {
  const missing = CHECKPOINT_HEADING_LIST.filter((heading) => !headingLine(heading).test(text));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
};

/**
 * Rewrite the four section headings as the canonical `##`.
 *
 * So every stored checkpoint has one shape, and the four sections read as
 * the siblings they are whatever level the secretary happened to use.
 */
export const normalizeCheckpoint = (text: string): string =>
  CHECKPOINT_HEADING_LIST.reduce((current, heading) => current.replace(headingLine(heading), heading), text);
