/**
 * shared — pure logic both halves (and the tests) use.
 *
 * Nothing here may import a module, a framework, or do I/O; the lint wall
 * enforces it. Grows as phases port more of 2.x's `@squad/shared`.
 *
 * The renderer imports specific files, never this barrel: `agenda.ts` pulls
 * zod, and 2.x's panel bundle once went from 12 KB to 333 KB through a barrel.
 */
export * from "./team-checkpoint-threshold.ts";
export * from "./team-artifact.ts";
export * from "./agent-reply-text.ts";
export * from "./agenda.ts";
export * from "./agenda-machine.ts";
export * from "./agenda-check.ts";
export * from "./seat-failure.ts";
export * from "./situation.ts";
export * from "./seat-usage.ts";
export * from "./agent-template.ts";
export * from "./material.ts";
export * from "./agenda-identity.ts";
export * from "./model-json.ts";
export * from "./host-name.ts";
export * from "./project-memory.ts";
export { quotesFrom, type Quote, type TranscriptLine as QuoteSourceLine } from "./quotes.ts";
export * from "./seat.ts";
export * from "./reasoning-effort.ts";
export * from "./connection.ts";
export * from "./agent-check.ts";
export * from "./prompt-blocks.ts";
export * from "./local-media.ts";
export * from "./roster-drift.ts";
export * from "./team-plan.ts";
export * from "./voices.ts";
export * from "./speakable.ts";
