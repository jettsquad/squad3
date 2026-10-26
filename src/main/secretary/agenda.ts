// 移植自 Squad 2.x packages/secretary/src/agenda.ts @ 8e96d9c
/**
 * agenda.ts — turning a host's sentence into a structured agenda.
 *
 * The secretary proposes; it never schedules. What comes back is a draft the
 * host confirms, which is why nothing here starts anything — the whole point
 * of the machine-proposes/human-decides split is that a wrong agenda costs a
 * confirmation click rather than a team's afternoon.
 *
 * The model's reply is JSON it wrote, so it is treated as hostile input all
 * the way through: prose around the object is tolerated, the schema is
 * strict, and the roster check runs afterwards because the shape being legal
 * says nothing about the seats being real.
 */
// Re-exported so existing importers keep working; the RULE lives in shared
// because it is about the host's own sentence, not about this service — and
// the console needs it too, on the other side of the plugin wall.
import { assertPublicHostCommand } from "../../shared/index.ts";

export { assertPublicHostCommand };
import {
  ACTION_KINDS,
  FEATURE_FLAGS,
  checkAgendaAgainstRoster,
  extractJsonObject,
  parseAgendaSpec,
  type AgendaSpec,
} from "../../shared/index.ts";

/** One seat as the drafting prompt needs to see it. */
export interface RosterSeat {
  readonly seatId: string;
  readonly displayName: string;
}

export interface AgendaDraftInput {
  /** The host's own words. */
  readonly command: string;
  readonly topic: string;
  readonly seats: readonly RosterSeat[];
}

/** Build the drafting instruction. English on purpose: it asks for JSON, and the schema names are English. */
export function buildAgendaPrompt(input: AgendaDraftInput): string {
  const roster = input.seats.map((seat) => `${seat.seatId} (${seat.displayName})`).join(", ");
  return [
    "You are a meeting secretary. Convert the host's instruction into a JSON team agenda.",
    "Reply with ONLY a JSON object (no prose, no code fence) matching exactly this shape:",
    '{"hostGoal"?: string, "phases": [{"title": string, "purpose"?: string, "contextMode": "independent"|"cumulative", "situation"?: {"action": string, "features": string[]}, "tasks": [{"seatId": string, "instruction": string, "publicContextCutoff"?: "phase-start"|"immediately-before-turn", "artifactPath"?: string}], "exit"?: "after-tasks"|"after-bounded-rounds"|"wait-for-host", "maxRounds"?: number, "id"?: string, "needs"?: string[], "check"?: {"command": string, "timeoutSec"?: number}, "maxAttempts"?: number}]}',
    // The check is what turns "the seat answered" into "the work is done".
    // Asked for on every phase that delivers something, because a phase
    // without one passes the moment anybody replies — which is how an agenda
    // once finished on five replies of 「前置没满足，不开工」.
    'Mind the level each key lives on: "publicContextCutoff" and "artifactPath" go INSIDE a task object; "check", "needs", "id", "maxAttempts", "exit", "maxRounds", "contextMode" and "situation" go on the PHASE. Never the other way round.',
    'Give a phase a "check" whenever it must DELIVER something that can be verified by a command: files exist, a commit is in git log, tests or a script exit 0. "check.command" is ONE shell command run in the project folder by the app itself after the phase\'s tasks; exit code 0 means the phase passed, anything else sends the same seats back with the output (up to "maxAttempts" tries, default 3). Take the command from what the host or the plan already states as the exit criterion (e.g. the plan says "scripts/exit-check.sh RB1 --commit exits 0" or "the commit feat(x): RB1 批次完成 exists" → check that). Never invent a criterion the plan does not state, and never write a check that cannot fail (e.g. "true", "echo ok", "|| true"). A search whose result nobody tests also cannot fail: `git log --grep=X` exits 0 when nothing matches, so write `git log --grep=X | grep -q .`. The app refuses a draft whose check it can see cannot fail. A check on a file the phase must produce has to test its CONTENT, not just that the file exists: `ls` or `wc -m` alone pass for a one-line stub or a status note. Assert something only the real deliverable has (a size floor with `test "$(wc -m < f)" -gt N`, a required heading or marker with `grep -q`, a value the plan names). Omit "check" for phases that are pure discussion or review with nothing a command can verify.',
    'A phase runs only after every phase it depends on has PASSED. By default it depends on the phase written just before it. Use "id" (short, unique) and "needs" (ids of EARLIER phases only) when that is not the real dependency — e.g. two phases that both depend on the same earlier one. Do not put "confirm the previous batch is committed before starting" into an instruction: the app enforces that through "needs" and the earlier phase\'s "check".',
    'Rules: use only the seatIds listed below; every phase needs at least one task; a phase that repeats rounds uses exit "after-bounded-rounds" WITH a positive integer maxRounds, and no other phase may set maxRounds.',
    'Set "artifactPath" ONLY when the host explicitly asks for that task\'s answer to be written to a file, and only with a path they actually name (relative to the project folder, e.g. "docs/review.md"). Never invent one: the app writes the file itself, so a made-up path sends later turns to a file that does not exist. Omit it otherwise. The app writes the seat\'s REPLY into that file, so use it only when the reply itself is the document. When the instruction tells the seat to save or write a file with its own tools (「保存成 md 文件」「写入某路径」), leave "artifactPath" out: otherwise the app overwrites the file the seat just wrote with the seat\'s short report about it.',
    'When one seat has to respond to, or keep a record of, what other seats said (a review round answered by a writer, minutes of a discussion), give the OTHER seats\' tasks an "artifactPath" so the app writes their replies to files, and tell the responding seat to read those files. Never instruct a seat to copy another seat\'s long reply verbatim into a file: that is slow, error-prone, and a long verbatim copy was refused by the model service\'s safety classifier three times in a row. Set "contextMode" to "independent" when the host wants each member to answer without seeing the others (e.g. 各自独立评审); otherwise "cumulative".',
    // Labelling the phase is not extra work asked of the model — deciding
    // what a phase is FOR is what drafting it already consists of. Naming it
    // is what lets the host's own criteria be consulted when the phase opens,
    // instead of only when somebody remembers to ask.
    `Set "situation" to describe what KIND of decision the phase makes. "action" is exactly one of: ${ACTION_KINDS.join(", ")}. "features" are properties of the thing being decided about, zero or more of: ${FEATURE_FLAGS.join(", ")}. Both lists are CLOSED — never invent a value; omit "situation" entirely if none of them fit.`,
    // Which shell runs the check (table/check.ts). Told here, because a check
    // written for the other one fails for a reason that has nothing to do with the work.
    process.platform === "win32"
      ? "Check commands run in Windows PowerShell, not a POSIX shell. Use native PowerShell syntax; Test-Path alone only prints a boolean and is not an assertion. Use if (...) { throw 'check failed' } to fail on missing or invalid content; do not use bash, grep, test -s, or POSIX quoting. Do not invent numeric acceptance thresholds unless the host specified them."
      : "Check commands run in /bin/sh. Use POSIX shell syntax and a nonzero exit status when the stated criterion is not met.",
    `Seats (use these exact seatIds): ${roster}.`,
    `Topic: ${input.topic}`,
    `Host instruction: ${input.command}`,
  ].join("\n");
}

/**
 * Pull the JSON object out of a reply that may carry stray prose.
 *
 * The rule itself lives in `@squad/shared` because the console needs the same
 * tolerance for team plans, on the other side of the plugin wall. What stays
 * here is the message: 「秘书没有返回 JSON」 says which job failed, which a
 * generic parse error cannot.
 */
export function extractJson(text: string): unknown {
  return extractJsonObject(text, "秘书没有返回 JSON 对象，无法解析成议程。");
}

/**
 * Parse and vet a drafting reply.
 *
 * Roster problems are refused rather than reported alongside a usable draft:
 * a draft the host can confirm is a draft the table will run, and a task
 * addressed to a seat that does not exist reads at execution time as a seat
 * that had nothing to say.
 */
/** Keys that belong on a task, and the keys that belong on a phase. */
const TASK_KEYS = ["publicContextCutoff", "artifactPath"] as const;
const PHASE_KEYS = ["check", "needs", "maxAttempts", "exit", "maxRounds", "contextMode", "situation"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Put a key written one level off back where it belongs.
 *
 * The shape has grown — a phase now carries a check, dependencies, an attempt
 * limit — and a model writing it sometimes sets a task's key on the phase, or
 * the reverse. What was meant is not in doubt: 「这一阶段各自独立作答」 written
 * as a phase-level `publicContextCutoff` means every task in it. Refusing the
 * whole draft over that costs the host a round to learn nothing, so the key
 * is moved rather than rejected.
 *
 * Only where the move is unambiguous. A phase-level key goes to every task
 * that does not set its own; a task-level key is lifted only when the phase
 * does not already say something else. Anything this does not recognise is
 * left for the schema to refuse, by name.
 */
export function settleMisplacedKeys(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw["phases"])) return raw;
  const phases = raw["phases"].map((entry) => {
    if (!isRecord(entry)) return entry;
    const phase: Record<string, unknown> = { ...entry };
    const tasks = Array.isArray(phase["tasks"])
      ? phase["tasks"].map((task) => (isRecord(task) ? { ...task } : task))
      : undefined;
    for (const key of TASK_KEYS) {
      if (!(key in phase)) continue;
      // A file path names ONE answer's destination; spread over several tasks
      // it would have them overwrite each other.
      const spreads = key !== "artifactPath" || tasks?.length === 1;
      if (tasks !== undefined && spreads) {
        for (const task of tasks) if (isRecord(task) && !(key in task)) task[key] = phase[key];
      }
      delete phase[key];
    }
    if (tasks !== undefined) {
      for (const task of tasks) {
        if (!isRecord(task)) continue;
        for (const key of PHASE_KEYS) {
          if (!(key in task)) continue;
          if (!(key in phase)) phase[key] = task[key];
          delete task[key];
        }
      }
      phase["tasks"] = tasks;
    }
    return phase;
  });
  return { ...raw, phases };
}

/** A schema refusal, as a sentence about the agenda rather than a dump of the validator. */
function readableSchemaError(error: unknown, raw: unknown): Error {
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return error instanceof Error ? error : new Error(String(error));
  const phases = isRecord(raw) && Array.isArray(raw["phases"]) ? raw["phases"] : [];
  const lines = issues.map((issue) => {
    const one = issue as { path?: unknown[]; message?: string; keys?: string[]; code?: string };
    const path = Array.isArray(one.path) ? one.path : [];
    const index = path[0] === "phases" && typeof path[1] === "number" ? path[1] : undefined;
    const phase = index === undefined ? undefined : phases[index];
    const where =
      index === undefined
        ? "议程"
        : `第 ${index + 1} 阶段${isRecord(phase) && typeof phase["title"] === "string" ? `「${phase["title"]}」` : ""}` +
          (path[2] === "tasks" && typeof path[3] === "number" ? `的第 ${path[3] + 1} 条任务` : "");
    const what =
      one.code === "unrecognized_keys" && Array.isArray(one.keys)
        ? `多了不认识的字段 ${one.keys.join("、")}`
        : `${path.slice(index === undefined ? 0 : path[2] === "tasks" ? 4 : 2).join(".") || "内容"}：${one.message ?? "格式不对"}`;
    return `- ${where}：${what}`;
  });
  return new Error(`秘书拟的议程格式不对，未采用。请让她重拟一次：\n${lines.join("\n")}`);
}

/**
 * A task that names its seat by the member's NAME instead of the seat id.
 * The prompt asks for ids, and some models write the names they read in the
 * discussion anyway (「阿明」 for seat-1; 2026-10-26, every task of a
 * 14-phase draft). A name that belongs to exactly one seat says who is meant
 * as plainly as the id would, so it is read as that seat; anything else —
 * unknown, or shared by two seats — still reaches the roster check and is
 * refused there, by its own words.
 *
 * 3 新增（2.x 拒掉整份草案）。
 */
export function seatIdsFromNames(agenda: AgendaSpec, seats: readonly RosterSeat[]): AgendaSpec {
  const ids = new Set(seats.map((seat) => seat.seatId));
  const byName = new Map<string, string | null>();
  for (const seat of seats) {
    const name = seat.displayName.trim();
    byName.set(name, byName.has(name) ? null : seat.seatId);
  }
  const resolve = (written: string): string => {
    if (ids.has(written)) return written;
    const name = written.trim().replace(/^@/, "").trim();
    return byName.get(name) ?? written;
  };
  return {
    ...agenda,
    phases: agenda.phases.map((phase) => ({
      ...phase,
      tasks: phase.tasks.map((task) => ({ ...task, seatId: resolve(task.seatId) })),
    })),
  };
}

export function parseAgendaReply(text: string, seats: readonly RosterSeat[]): AgendaSpec {
  const raw = settleMisplacedKeys(extractJson(text));
  let agenda: AgendaSpec;
  try {
    agenda = seatIdsFromNames(parseAgendaSpec(raw), seats);
  } catch (error) {
    throw readableSchemaError(error, raw);
  }
  const problems = checkAgendaAgainstRoster(
    agenda,
    seats.map((seat) => seat.seatId),
  );
  if (problems.length > 0) {
    throw new Error(
      `秘书拟的议程有问题，未采用：\n${problems.map((p) => `- 阶段「${p.phase}」：${p.detail}`).join("\n")}`,
    );
  }
  return agenda;
}
