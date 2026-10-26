// 移植自 Squad 2.x packages/table/src/roster.ts @ 8dcb903
/**
 * roster.ts — the rules a team's seat list has to keep.
 *
 * Pure, because each of these fails quietly if it is not enforced: a team
 * with two secretaries has one that never gets asked, a team with none has
 * judgement work landing on whoever happens to be first, and a duplicate seat
 * id makes two members indistinguishable in the record forever.
 */
import type { SeatSpec } from "../../shared/seat.ts";

export interface RosterProblem {
  readonly detail: string;
}

/**
 * Check a proposed roster.
 *
 * At most ONE secretary, and 1.x's rule for what happens when a second is
 * named is deliberately NOT reproduced here: it silently replaced the old
 * one. Replacement without a word means a team can lose its secretary
 * designation as a side effect of editing an unrelated seat, and the only
 * evidence is that judgement work starts going somewhere else. This refuses
 * instead and makes the caller unset the first.
 */
export function checkRoster(seats: readonly SeatSpec[]): readonly RosterProblem[] {
  const problems: RosterProblem[] = [];
  if (seats.length === 0) problems.push({ detail: "一支团队至少要有一个席位。" });

  const seen = new Set<string>();
  const names = new Set<string>();
  for (const seat of seats) {
    if (seen.has(seat.seatId)) problems.push({ detail: `席位 id 重复：${seat.seatId}` });
    seen.add(seat.seatId);
    // Display names too: the record identifies a speaker by name, so two
    // seats called 甲 are one speaker as far as every later reader is
    // concerned — including the assembler and the secretary.
    if (names.has(seat.displayName)) problems.push({ detail: `席位名重复：${seat.displayName}` });
    names.add(seat.displayName);
  }

  const secretaries = seats.filter((seat) => seat.isSecretary === true);
  if (secretaries.length > 1) {
    problems.push({
      detail: `一支团队只能有一位秘书，现在指派了 ${secretaries.map((seat) => seat.displayName).join("、")}。`,
    });
  }
  return problems;
}

/** The designated secretary, or nobody. */
export const secretaryOf = (seats: readonly SeatSpec[]): SeatSpec | undefined =>
  seats.find((seat) => seat.isSecretary === true);

/**
 * Whether a seat may leave.
 *
 * A team cannot go empty, and the secretary cannot leave silently: judgement
 * work would keep being requested and would start landing on a default
 * nobody chose. Removing them is allowed, but the caller has to mean it.
 */
export function checkRemoval(
  seats: readonly SeatSpec[],
  seatId: string,
  options: { readonly allowSecretary?: boolean } = {},
): readonly RosterProblem[] {
  const seat = seats.find((candidate) => candidate.seatId === seatId);
  if (seat === undefined) return [{ detail: `这支团队里没有席位 ${seatId}。` }];
  if (seats.length <= 1) return [{ detail: "不能移走最后一个席位。" }];
  if (seat.isSecretary === true && options.allowSecretary !== true) {
    return [{ detail: `${seat.displayName} 是这支团队的秘书。要移走它，请先指派别人或明确确认。` }];
  }
  return [];
}

/**
 * Where a seat goes in the roster.
 *
 * Roster order is speaking order in a round, so this is not cosmetic: an edit
 * that re-appends a seat silently changes who answers first, and the person
 * who edited a connection did not decide that. `at === undefined` means the
 * end, which is what adding a genuinely new seat wants.
 */
export function placeSeat<T>(seats: readonly T[], seat: T, at?: number): readonly T[] {
  if (at === undefined) return [...seats, seat];
  const next = [...seats];
  next.splice(Math.max(0, Math.min(at, next.length)), 0, seat);
  return next;
}
