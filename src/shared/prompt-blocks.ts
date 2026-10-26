// 移植自 Squad 2.x packages/shared/src/prompt-blocks.ts @ 8dcb903
/**
 * prompt-blocks.ts — the middle tier of a seat's prompt.
 *
 * A seat used to read exactly two things: whatever its own prompt said, and
 * whatever the round carried. So anything true of SEVERAL seats had to be
 * copied into each of them, and copies drift — an edit lands on four of five
 * and the fifth goes on working from the old rule. Silently, because a seat
 * with stale standing instructions answers confidently rather than failing.
 *
 * Three tiers now: what the whole table reads, what a NAMED GROUP of seats
 * reads, and what this seat alone reads. The middle one is the part that
 * needed a shape, and the shape it needed is not a group of seats — it is a
 * SET: some blocks, some seats, a name. Membership overlaps in practice (the
 * seats that write share a method; the seats that publish share a compliance
 * rule; one seat does both), and overlapping subsets are what a list of sets
 * expresses naturally and a partition does not.
 *
 * Everything here is pure. Which blocks a seat reads, in what order, with
 * what removed, is the part that decides behaviour, and it should be
 * decidable in a test rather than by reading a prompt in a browser.
 */

/** One reusable piece of standing instructions. */
export interface PromptBlock {
  readonly blockId: string;
  /** Becomes the section heading in the prompt, so it is read, not just stored. */
  readonly name: string;
  readonly text: string;
}

/** Some blocks, some seats, a name. The middle tier's whole model. */
export interface PromptSet {
  readonly setId: string;
  readonly name: string;
  /** In this order. */
  readonly blockIds: readonly string[];
  readonly seatIds: readonly string[];
}

/** What a team keeps: its own copies of the blocks, plus how they are used. */
export interface TeamPrompts {
  /** The team's copies. Ids match the library entry they came from. */
  readonly blocks: readonly PromptBlock[];
  /** Read by every seat, in this order, before any set. */
  readonly teamBlockIds: readonly string[];
  /** Applied in this order, after the team's blocks. */
  readonly sets: readonly PromptSet[];
}

export const EMPTY_TEAM_PROMPTS: TeamPrompts = { blocks: [], teamBlockIds: [], sets: [] };

/**
 * The blocks one seat reads, in order, deduplicated.
 *
 * Order is the argument, not a preference: what the whole team is doing is
 * the frame, what this group of seats does is inside it, and what this seat
 * does is inside that. Read the other way round, a seat treats the shared
 * rules as commentary on its own job.
 *
 * DEDUPLICATED, first occurrence wins. A block reachable through two sets —
 * the same self-check listed by 「产出型席位」 and by 「对外交付」 — would
 * otherwise be printed twice, and a model reading one instruction twice does
 * not conclude it was configured twice; it concludes the instruction matters
 * more than the ones around it.
 *
 * Ids that name nothing are skipped rather than throwing. This runs on every
 * turn of every seat, and a block deleted from the library must not be able
 * to stop a round — the missing text is visible in the composed prompt, which
 * is where a person is looking when they ask why a seat changed.
 */
export function blocksForSeat(prompts: TeamPrompts, seatId: string): readonly PromptBlock[] {
  const byId = new Map(prompts.blocks.map((block) => [block.blockId, block]));
  const wanted = [
    ...prompts.teamBlockIds,
    ...prompts.sets.filter((set) => set.seatIds.includes(seatId)).flatMap((set) => set.blockIds),
  ];
  const seen = new Set<string>();
  const out: PromptBlock[] = [];
  for (const id of wanted) {
    if (seen.has(id)) continue;
    seen.add(id);
    const block = byId.get(id);
    if (block !== undefined && block.text.trim() !== "") out.push(block);
  }
  return out;
}

/** Which sets a seat belongs to, for a screen that has to explain the result. */
export function setsForSeat(prompts: TeamPrompts, seatId: string): readonly PromptSet[] {
  return prompts.sets.filter((set) => set.seatIds.includes(seatId));
}

/**
 * The blocks as prompt text.
 *
 * Each under its own name, rather than merged under one 「共用」 heading: the
 * name is how a person reading the composed prompt tells which library entry
 * a paragraph came from, and merging them turns three traceable sections into
 * one anonymous wall.
 */
export function promptBlockSections(blocks: readonly PromptBlock[]): readonly string[] {
  return blocks.flatMap((block) => ["", `## ${block.name.trim()}`, block.text.trim()]);
}

/**
 * What is wrong with a set, and whether it is wrong enough to refuse.
 *
 * The distinction is load-bearing, and the first version did not have it. An
 * `error` names something that does not exist — corruption, never stored. A
 * `warning` is a set that is merely useless: no blocks, nobody reading it.
 * That is the NORMAL state of a set one second after you create it, and
 * refusing it made 「新建集合」 impossible to use — the only route to a valid
 * set ran through a state the server would not accept.
 */
export interface PromptSetProblem {
  readonly field: string;
  readonly severity: "error" | "warning";
  readonly detail: string;
}

export function checkPromptSet(
  set: PromptSet,
  known: { readonly blockIds: readonly string[]; readonly seatIds: readonly string[] },
): readonly PromptSetProblem[] {
  const problems: PromptSetProblem[] = [];
  if (set.name.trim() === "") {
    problems.push({
      field: "name",
      severity: "warning",
      detail: "集合还没有名字——名字会出现在解释「这个席位为什么这么答」的地方。",
    });
  }
  if (set.blockIds.length === 0) {
    problems.push({ field: "blockIds", severity: "warning", detail: "还没有片段，挂上也不会有任何效果。" });
  }
  if (set.seatIds.length === 0) {
    problems.push({ field: "seatIds", severity: "warning", detail: "还没有席位读它——建了没人用的集合是纯成本。" });
  }
  for (const id of set.blockIds) {
    if (!known.blockIds.includes(id)) {
      problems.push({ field: "blockIds", severity: "error", detail: `本队没有「${id}」这段片段。` });
    }
  }
  for (const id of set.seatIds) {
    if (!known.seatIds.includes(id)) {
      problems.push({ field: "seatIds", severity: "error", detail: `本队没有「${id}」这个席位。` });
    }
  }
  return problems;
}
