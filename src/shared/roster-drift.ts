// 移植自 Squad 2.x packages/console/src/roster-drift.ts @ 8dcb903
/**
 * roster-drift.ts — who is not the same as when you said yes.
 *
 * A confirmed agenda is executed against the CURRENT roster, deliberately: a
 * member added while it runs should be usable, and a plan frozen against a
 * snapshot would keep addressing a seat that has left. 1.x carried
 * `scope.participantSnapshot` and this is the other half of that idea — the
 * snapshot is kept so the difference can be SHOWN, not so it can be enforced.
 *
 * Named rather than counted. 「名册变了」 is not something a person can act
 * on; 「郑三 已不在」 is.
 */

export interface RosterMember {
  readonly seatId: string;
  readonly displayName: string;
}

/**
 * What moved between confirmation and now.
 *
 * Compared by `seatId`, not by name: two seats can share a display name, and
 * a renamed seat is the same chair — reporting it as "left and joined" would
 * be noise about something nobody changed.
 */
export function driftBetween(then: readonly RosterMember[], now: readonly RosterMember[]): readonly string[] {
  const nowIds = new Set(now.map((seat) => seat.seatId));
  const thenIds = new Set(then.map((seat) => seat.seatId));
  return [
    ...then.filter((seat) => !nowIds.has(seat.seatId)).map((seat) => `${seat.displayName} 已不在`),
    ...now.filter((seat) => !thenIds.has(seat.seatId)).map((seat) => `${seat.displayName} 是后来加入的`),
  ];
}
