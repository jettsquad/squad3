// 移植自 Squad 2.x packages/shared/src/team-plan.ts @ 8e96d9c
/**
 * team-plan.ts — the shape of a team somebody proposed building.
 *
 * Here rather than in a plugin for the same reason `agenda.ts` is here, and
 * it is the only reason that earns a place in this package: it genuinely has
 * two consumers on opposite sides of the plugin wall. ③ the secretary
 * PROPOSES one from a discussion; the console INSTANTIATES one the host
 * confirmed, into agent templates and a roster. Neither may import the other.
 *
 * The problem it exists for is that a MISSING SEAT does not announce itself.
 * A team built to write articles that has nobody answering "will this pass
 * the platform's rules" runs perfectly: every round succeeds, every seat
 * answers, and the output is quietly always short of publishable. That is the
 * same family as a checkpoint missing its 「未决分歧」 section — the failure
 * reads as an absence of content rather than as a fault.
 *
 * So nothing here trusts the producer. The schema is strict (unknown keys
 * rejected, not ignored — a key the model invented is an instruction it
 * believes it gave us), and the checks a schema cannot make run separately in
 * `checkTeamPlan`.
 */
import { z } from "zod";
import { canonicalJson } from "./agenda-identity.ts";
import { AgendaPhaseSchema, checkAgendaAgainstRoster, type AgendaSpec } from "./agenda.ts";
import { permissionModesFor, type AgentBackend, type PermissionMode } from "./agent-template.ts";

/**
 * How many people a plan may seat.
 *
 * One is not a team. The ceiling is the interesting half: every extra seat
 * costs a turn per round and crowds every other seat's window, and a team of
 * twelve fails by having nobody responsible — while running, from the
 * outside, exactly like a team of five. Refusing at the plan is the only
 * moment where that is cheap to say.
 */
export const MIN_PLAN_SEATS = 2;
export const MAX_PLAN_SEATS = 8;

const BACKENDS = ["claude-code", "codex", "dsh"] as const;
// Fails to compile if `AgentBackend` ever gains a member this list has not.
const _backendsMatch: readonly AgentBackend[] = BACKENDS;
void _backendsMatch;

/**
 * A seat as proposed, before it exists.
 *
 * `key` rather than `seatId` is load-bearing. A `seatId` is minted at the
 * moment a team is created (`seat-1`, `seat-2`, …), so a plan names seats
 * that DO NOT EXIST YET. Let a model write `seat-3` and you get an id that is
 * well-formed, passes every existence check, and after instantiation points
 * at somebody else — because existence is what those checks test, not
 * identity.
 */
export const TeamPlanSeatSchema = z
  .object({
    /** Unique within the plan; what the opening agenda points at. */
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "key 只能用小写字母、数字和连字符"),
    displayName: z.string().min(1).max(60),
    role: z.string().min(1).max(120),
    /** Standing instructions. The one thing this agent reads every round. */
    systemPrompt: z.string().min(1),
    backend: z.enum(BACKENDS),
    secretaryCandidate: z.boolean(),
    webAccess: z.boolean().optional(),
    permissionMode: z.string().min(1).optional(),
    /**
     * Optional, unlike `AgentTemplate`'s: a tint is the one field where
     * refusing an otherwise good plan would be absurd. Instantiation falls
     * back to a palette position.
     */
    color: z.string().min(1).optional(),
    /**
     * Why this seat exists. For the host to read while confirming, and it
     * does not travel into the agent library.
     *
     * Required, because it is the field that makes a padded roster visible.
     * A seat whose reason is 「负责内容质量」 next to another whose reason is
     * 「把关文章质量」 is one seat written twice, and that is legible in the
     * rationales long before it is legible in the prompts.
     */
    rationale: z.string().min(1),
  })
  .strict();

/**
 * One instruction in the opening agenda, addressed to a seat by its `key`.
 *
 * `seatKey`, not `key`. It was `key` — the same word the seat itself uses —
 * and inside a task object that reads as 「this task's key」: a model filled
 * it with slugs naming the OUTPUT (`kickoff-brief`, `english-drafts`), which
 * is a perfectly sensible reading of the field it was shown. The whole plan
 * then failed the roster check nineteen times over, and every seat came back
 * 「一次都没有被点到」. The field has to say whose key it is.
 */
export const TeamPlanTaskSchema = z
  .object({
    seatKey: z.string().min(1),
    instruction: z.string().min(1),
    publicContextCutoff: z.enum(["phase-start", "immediately-before-turn"]).optional(),
    artifactPath: z.string().min(1).max(400).optional(),
  })
  .strict();

/**
 * A phase of the opening agenda.
 *
 * Deliberately the same fields as `AgendaPhaseSchema` minus the seat naming,
 * so that `openingAgenda` becomes a real `AgendaSpec` by substitution alone
 * (`resolveOpeningAgenda`) rather than by a translation that can drift.
 */
export const TeamPlanPhaseSchema = z
  .object({
    title: z.string().min(1),
    purpose: z.string().min(1).optional(),
    contextMode: z.enum(["independent", "cumulative"]),
    tasks: z.array(TeamPlanTaskSchema).min(1),
    situation: AgendaPhaseSchema.shape.situation,
    exit: z.enum(["after-tasks", "after-bounded-rounds", "wait-for-host"]).optional(),
    maxRounds: z.number().int().positive().optional(),
  })
  .strict();

export const TeamPlanSchema = z
  .object({
    teamName: z.string().min(1).max(80),
    /** The host's goal, restated as one sentence somebody could judge. */
    goal: z.string().min(1),
    /**
     * What the clarifying phase got out of the host: hours per week, the
     * platform, what they already have. These are the facts no model has a
     * route to — see engineering.md on implicit constraints — so a plan that
     * carries none of them was drafted without asking.
     */
    constraints: z.array(z.string().min(1)).default([]),
    seats: z.array(TeamPlanSeatSchema).min(1),
    secretaryKey: z.string().min(1),
    openingAgenda: z
      .object({
        hostGoal: z.string().min(1).optional(),
        phases: z.array(TeamPlanPhaseSchema).min(1),
      })
      .strict(),
    /** What the red team said this roster will fail at. */
    risks: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type TeamPlanSeat = z.infer<typeof TeamPlanSeatSchema>;
export type TeamPlanTask = z.infer<typeof TeamPlanTaskSchema>;
export type TeamPlanPhase = z.infer<typeof TeamPlanPhaseSchema>;
export type TeamPlan = z.infer<typeof TeamPlanSchema>;

/** Structural validation only; see `checkTeamPlan` for the rest. */
export const parseTeamPlan = (value: unknown): TeamPlan => TeamPlanSchema.parse(value);

/** A complaint tagged with the input that caused it, so a form can place it. */
export interface TeamPlanProblem {
  readonly field: string;
  readonly detail: string;
}

/**
 * The plan's agenda with keys standing in for seat ids.
 *
 * Exists so the agenda rules — a task must name a real member, a
 * bounded-rounds phase must carry its bound — are checked by the SAME
 * function the table already trusts, rather than by a second copy that
 * drifts. Keys are ids here; they become real ids in `resolveOpeningAgenda`.
 */
export function agendaWithKeys(plan: TeamPlan): AgendaSpec {
  return {
    ...(plan.openingAgenda.hostGoal === undefined ? {} : { hostGoal: plan.openingAgenda.hostGoal }),
    phases: plan.openingAgenda.phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map(({ seatKey, ...rest }) => ({ seatId: seatKey, ...rest })),
    })),
  };
}

/**
 * The checks a schema cannot make.
 *
 * Every one of these produces something that PARSES and then fails silently
 * or late, which is the only kind worth a separate pass.
 */
export function checkTeamPlan(plan: TeamPlan): readonly TeamPlanProblem[] {
  const problems: TeamPlanProblem[] = [];

  if (plan.seats.length < MIN_PLAN_SEATS) {
    problems.push({ field: "seats", detail: `${plan.seats.length} 个席位不算一支团队，至少要 ${MIN_PLAN_SEATS} 个。` });
  }
  if (plan.seats.length > MAX_PLAN_SEATS) {
    problems.push({
      field: "seats",
      detail:
        `${plan.seats.length} 个席位太多了（上限 ${MAX_PLAN_SEATS}）。每多一席，每轮都多一次开销、` +
        `每个人的窗口都更挤——而人太多的团队跑起来一切正常，只是没有人真正负责。请先合并职能。`,
    });
  }

  const seen = new Map<string, number>();
  plan.seats.forEach((seat, index) => {
    const first = seen.get(seat.key);
    if (first === undefined) {
      seen.set(seat.key, index);
    } else {
      problems.push({
        field: `seats[${index}].key`,
        detail: `key「${seat.key}」和第 ${first + 1} 个席位重复了——重复的 key 在之后每一次读取里都不可区分。`,
      });
    }
    const modes = permissionModesFor(seat.backend);
    // Caught here rather than at `checkRoster`, which would refuse the whole
    // creation after the templates are already written. Two members with one
    // name are also indistinguishable in every later reading of the record —
    // the discussion, the checkpoint, the audit.
    const twin = plan.seats.findIndex((other) => other.displayName === seat.displayName);
    if (twin !== index) {
      problems.push({
        field: `seats[${index}].displayName`,
        detail: `名字「${seat.displayName}」和第 ${twin + 1} 个席位重复了——同名的两个人在讨论记录里分不开。`,
      });
    }
    if (seat.permissionMode !== undefined && !modes.includes(seat.permissionMode as PermissionMode)) {
      problems.push({
        field: `seats[${index}].permissionMode`,
        detail:
          `${seat.backend} 没有「${seat.permissionMode}」这个权限模式——它会被原样交给子进程，` +
          `报错来自 CLI 而不是这里。可选：${modes.join("、")}。`,
      });
    }
  });

  const keys = plan.seats.map((seat) => seat.key);
  const known = new Set(keys);

  const secretary = plan.seats.find((seat) => seat.key === plan.secretaryKey);
  if (secretary === undefined) {
    problems.push({
      field: "secretaryKey",
      detail: `名册里没有「${plan.secretaryKey}」这个 key，秘书指给了一个不存在的人。`,
    });
  } else if (!secretary.secretaryCandidate) {
    // The agent library's rule, one layer up: an agent whose instructions
    // never mentioned planning an agenda should not become the seat that
    // plans one because a field was set elsewhere.
    problems.push({
      field: "secretaryKey",
      detail: `「${secretary.displayName}」没有标记为可以当秘书（secretaryCandidate），不能被指成秘书。`,
    });
  }

  // Reused rather than reimplemented; the field names are translated back so
  // a complaint lands on the input a person can see.
  for (const problem of checkAgendaAgainstRoster(agendaWithKeys(plan), keys)) {
    problems.push({
      field: "openingAgenda",
      detail: `阶段「${problem.phase}」：${problem.detail.replace("席位", "席位 key")}`,
    });
  }

  /**
   * A seat nobody is scheduled to use.
   *
   * The inverse of the missing-seat problem and the harder half: a roster
   * that is short gets noticed when the work comes back thin, but a seat that
   * is built and never called costs money, crowds the record, and NOTHING
   * ever reports it. This is the check the whole file is for.
   */
  const used = new Set<string>();
  for (const phase of plan.openingAgenda.phases) {
    for (const task of phase.tasks) if (known.has(task.seatKey)) used.add(task.seatKey);
  }
  for (const [index, seat] of plan.seats.entries()) {
    if (!used.has(seat.key)) {
      problems.push({
        field: `seats[${index}].key`,
        detail:
          `「${seat.displayName}」在首场议程里一次都没有被点到——建了没人用的席位是纯成本。` +
          `要么给它安排任务，要么把它从名册里去掉。`,
      });
    }
  }

  return problems;
}

/**
 * Turn a plan's opening agenda into a real one, once the seats exist.
 *
 * The `key → seatId` substitution named in §2.1 of the spec. It refuses on an
 * unmapped key rather than dropping the task: a dropped task is a phase where
 * somebody simply had nothing to say, which is precisely the reading this
 * whole design is trying to make impossible.
 */
export function resolveOpeningAgenda(plan: TeamPlan, seatIdByKey: ReadonlyMap<string, string>): AgendaSpec {
  return {
    ...(plan.openingAgenda.hostGoal === undefined ? {} : { hostGoal: plan.openingAgenda.hostGoal }),
    phases: plan.openingAgenda.phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map(({ seatKey, ...rest }) => {
        const seatId = seatIdByKey.get(seatKey);
        if (seatId === undefined) {
          throw new Error(`议程点名了「${seatKey}」，但建团后没有对应的席位——这份方案没有落地。`);
        }
        return { seatId, ...rest };
      }),
    })),
  };
}

/**
 * The plan as stable bytes, for the fingerprint that goes into the audit.
 *
 * Same rules as an agenda's, and the same reason: 「落地的是不是我确认的那一
 * 份」 has to stay answerable after everybody has forgotten. Hashing these
 * bytes happens on the side that has `node:crypto`; this package is bundled
 * into the browser panel.
 */
export function canonicalTeamPlan(plan: TeamPlan): string {
  return canonicalJson(plan);
}
