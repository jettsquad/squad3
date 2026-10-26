/**
 * wire.ts — the one contract between the renderer and the main process.
 *
 * Both halves import this file, so a method name or a field cannot differ
 * between them without the build saying so. 1.x had one IPC channel per
 * feature, each with its own hand-written checks, and `electron.ts` grew to
 * 1,758 lines of them; that is the reason 2.0 left Electron. Here there is one
 * table, one schema per method, and validation written once in the dispatcher.
 *
 * Adding a method means adding a row here and a handler in the main process.
 * Nothing else — no preload change, no new channel.
 */
import { z } from "zod";
import { CLAUDE_PERMISSION_MODES, CODEX_PERMISSION_MODES } from "./agent-template.ts";
import { AgendaSpecSchema } from "./agenda.ts";
import { REASONING_EFFORTS } from "./reasoning-effort.ts";
import { TeamPlanSchema } from "./team-plan.ts";

const usage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
  contextTokens: z.number().optional(),
});

const usageTotals = usage.extend({ turns: z.number() });

const backend = z.enum(["claude-code", "codex", "dsh"]);
const optionalCount = z.number().int().positive().optional();
const caps = z
  .object({ maxTurns: optionalCount, maxTokens: optionalCount, maxCostUsd: z.number().positive().optional() })
  .strict();
const permissionMode = z.enum([...CLAUDE_PERMISSION_MODES, ...CODEX_PERMISSION_MODES]);
const reasoningEffort = z.enum(REASONING_EFFORTS);

const connection = z
  .object({
    connectionId: z.string().trim().min(1),
    displayName: z.string().trim().min(1, "连接名不能是空的。"),
    authMode: z.enum(["subscription", "api-key"]),
    backend,
    modelId: z.string().optional(),
    endpoint: z.string().optional(),
    credentialRef: z.string().optional(),
    authHeader: z.enum(["x-api-key", "bearer"]).optional(),
  })
  .strict();
const connectionView = connection.extend({
  credentialConfigured: z.boolean(),
  credentialWritable: z.boolean(),
  /** The stored credential name is malformed; the connection is listed, said, and editable. */
  credentialProblem: z.string().optional(),
});

const agent = z
  .object({
    templateId: z.string().trim().min(1),
    displayName: z.string(),
    role: z.string(),
    systemPrompt: z.string(),
    backend,
    connectionId: z.string().optional(),
    permissionMode: permissionMode.optional(),
    reasoningEffort: reasoningEffort.optional(),
    caps: caps.optional(),
    secretaryCandidate: z.boolean(),
    color: z.string(),
    voiceId: z.string().optional(),
    webAccess: z.boolean().optional(),
    hostCustomizations: z.boolean().optional(),
    subagents: z.boolean().optional(),
    enabled: z.boolean(),
    order: z.number().optional(),
  })
  .strict();

const settings = z
  .object({
    hostDisplayName: z.string().optional(),
    distilConnectionId: z.string().optional(),
    notifyOnFinish: z.boolean().optional(),
    dshCommand: z.string().optional(),
    language: z.enum(["zh", "en"]).optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    /** How big everything in the window is drawn, 1 being normal. */
    fontScale: z.number().min(0.8).max(1.6).optional(),
    criteriaFolder: z.string().optional(),
    speechConnectionId: z.string().optional(),
    speechSpeed: z.number().min(0.5).max(2).optional(),
    dictationConnectionId: z.string().optional(),
    dictationModel: z.string().optional(),
  })
  .strict();
const seatState = z.enum(["queued", "running", "answered", "failed", "stopped"]);

const seatSummary = z.object({
  seatId: z.string(),
  displayName: z.string(),
  role: z.string(),
  backend,
  isSecretary: z.boolean(),
  /** Working on a command right now. */
  working: z.boolean(),
  /** Characters of output so far this turn, while working. */
  received: z.number(),
  /** What its own stream says it is running, while working. */
  doing: z.string().optional(),
  /** When the current turn started, while working (ms since epoch). */
  startedAt: z.number().optional(),
  /** Sub-agents it has running now (Claude Code's Agent tool); 0 when none. */
  subagents: z.number(),
  /** Set when it has been quiet a full window with a command still open: left running, and said so. */
  quiet: z.string().optional(),
  /** The start of the command it is answering, while working. */
  answering: z.string().optional(),
  /** Commands waiting for this seat. */
  queued: z.number(),
  /** Its next turn continues its own CLI conversation. */
  continuing: z.boolean(),
  usage: usageTotals,
  /** The library agent it was copied from. */
  templateId: z.string().optional(),
  connectionId: z.string().optional(),
  /** The connection's name, or absent for the host's own login. */
  connectionName: z.string().optional(),
  permissionMode: z.string().optional(),
  reasoningEffort: z.string().optional(),
  caps: caps.optional(),
  color: z.string().optional(),
  voiceId: z.string().optional(),
  /**
   * Why this seat cannot run as configured: its connection or its agent is
   * gone from the library. Said on the roster, before a round finds out.
   */
  problem: z.string().optional(),
});

const commandView = z.object({
  commandId: z.string(),
  excerpt: z.string(),
  state: z.enum(["queued", "running", "done", "stopped", "interrupted"]),
  seats: z.array(z.object({ seatId: z.string(), displayName: z.string(), state: seatState })),
});

const archivedSession = z.object({
  teamId: z.string(),
  label: z.string(),
  archivedAt: z.number(),
  createdAt: z.number(),
});

const teamSummary = z.object({
  /** One session's id: everything below is this session's, except what its team holds in common. */
  teamId: z.string(),
  displayName: z.string(),
  /** The team this session belongs to (its first session's id); equal to `teamId` for the first. */
  groupId: z.string(),
  /** 「第 2 场 · 10-22 19:40」, or the name the host gave it. */
  sessionLabel: z.string(),
  /** How many live sessions the team has. */
  sessionCount: z.number(),
  sessionName: z.string().optional(),
  createdAt: z.number(),
  projectFolder: z.string(),
  hostDisplayName: z.string(),
  seats: z.array(seatSummary),
  busy: z.boolean(),
  usage: usageTotals,
  /** Open and interrupted commands: what can be stopped or sent again. */
  commands: z.array(commandView),
  prompts: z.lazy(() => teamPrompts),
  agenda: z.lazy(() => agendaView),
  /** What the team holds. Text stays in the main process; the window needs names and sizes. */
  materials: z.array(
    z.object({
      materialId: z.string(),
      name: z.string(),
      chars: z.number(),
      pinned: z.boolean(),
      addedAt: z.number(),
      /** A pasted or picked picture: the file it was saved to. */
      imagePath: z.string().optional(),
    }),
  ),
  /** Team copies whose text differs from the library entry they came from. */
  editedBlockIds: z.array(z.string()),
  /** The fold threshold as a fraction of the context window; absent is the default. */
  checkpointCoefficient: z.number().optional(),
  /** What was decided about this team, newest last. */
  audit: z.array(z.object({ at: z.number(), kind: z.string(), detail: z.string(), agendaHash: z.string().optional() })),
});

const exitCheck = z.object({
  exitCode: z.number().nullable(),
  tail: z.string(),
  at: z.number(),
  timedOut: z.boolean().optional(),
});

const agendaView = z.object({
  /** The secretary's draft, waiting on the host. */
  draft: z
    .object({
      agenda: AgendaSpecSchema,
      agendaId: z.string(),
      revision: z.number(),
      at: z.number(),
      fromEntryId: z.string().optional(),
      /** Who wrote it, when not the secretary. */
      author: z.enum(["plan-opening", "designer-seed"]).optional(),
      /** The host's own criteria bearing on this plan: for the host's eyes, never the record. */
      criteria: z.array(z.string()),
      /** Checked against the roster as it is now. */
      problems: z.array(z.string()),
    })
    .optional(),
  /** The confirmed plan and where each node stands. Kept after it finishes. */
  confirmed: z
    .object({
      agenda: AgendaSpecSchema,
      at: z.number(),
      /** Short form of the confirmation fingerprint. */
      hash: z.string(),
      proxy: z.boolean(),
      standing: z.enum(["runnable", "deciding", "finished", "ended"]),
      nodes: z.array(
        z.object({
          nodeId: z.string(),
          title: z.string(),
          state: z.enum(["pending", "passed", "deciding", "unresolved", "skipped"]),
          attempts: z.number(),
          why: z.string().optional(),
          lastCheck: exitCheck.optional(),
          check: z.string().optional(),
        }),
      ),
      /** Who left or joined since confirmation, by name. */
      drift: z.array(z.string()),
      /** What Lil X decided while nobody was watching: the first thing to want on coming back. */
      decisions: z.array(z.object({ at: z.number(), title: z.string(), problem: z.string(), detail: z.string() })),
      reportPath: z.string().optional(),
    })
    .optional(),
  running: z.object({ phase: z.string(), phaseIndex: z.number(), phaseCount: z.number() }).optional(),
  /** Confirmed while commands were running; starts when they finish. */
  waiting: z.boolean().optional(),
});

const decision = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retry"), instruction: z.string().optional() }).strict(),
  z
    .object({
      kind: z.literal("assign"),
      seatId: z.string(),
      instruction: z.string().trim().min(1, "清障要做的事不能是空的。"),
    })
    .strict(),
  z.object({ kind: z.literal("pass") }).strict(),
  z.object({ kind: z.literal("abandon"), why: z.string().optional() }).strict(),
]);

const criterionView = z.object({
  id: z.string(),
  claim: z.string(),
  boundary: z.string().optional(),
  trigger: z.object({ action: z.array(z.string()), features: z.array(z.string()) }),
  /** How many instances support it — never the instances: they stay in the library. */
  evidence: z.number(),
  status: z.enum(["active", "suspect", "retired"]),
  /** For live criteria: which of the three scales it fails, if any. */
  health: z.object({ verdict: z.string(), detail: z.string() }).optional(),
});

const promptBlock = z.object({ blockId: z.string().trim().min(1), name: z.string(), text: z.string() }).strict();
const teamPrompts = z
  .object({
    blocks: z.array(promptBlock),
    teamBlockIds: z.array(z.string()),
    sets: z.array(
      z
        .object({
          setId: z.string(),
          name: z.string(),
          blockIds: z.array(z.string()),
          seatIds: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

const transcriptLine = z.object({
  seq: z.number(),
  /** What quotes and checkpoints point at. */
  entryId: z.string(),
  /** The command this line opens or answers. */
  commandId: z.string().optional(),
  kind: z.enum(["host", "seat", "system", "proxy", "checkpoint"]),
  speaker: z.string(),
  /** A host line the agenda sent for this phase: the agenda's words, not the host's. */
  agendaPhase: z.string().optional(),
  /** A host line the program wrote on the host's behalf (a plan redraft request). */
  sentFor: z.enum(["plan-redraft"]).optional(),
  seatId: z.string().optional(),
  text: z.string(),
  at: z.number(),
  failed: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  /** How many lines of discussion the seat was handed. "Empty window" and "ignored a full one" are different failures. */
  contextLines: z.number().optional(),
  durationMs: z.number().optional(),
  usage: usage.optional(),
  checkpointId: z.string().optional(),
  revoked: z.boolean().optional(),
});

const contextState = z.object({
  crossed: z.boolean(),
  accumulated: z.number(),
  limit: z.number(),
  holdReason: z.enum(["below-threshold", "already-running", "team-busy"]).optional(),
  folding: z.boolean(),
  checkpoint: z.object({ checkpointId: z.string(), text: z.string(), at: z.number() }).optional(),
  history: z.array(z.object({ checkpointId: z.string(), at: z.number(), revoked: z.boolean() })),
  lastFailure: z.string().optional(),
});

const nonEmpty = (label: string) => z.string().trim().min(1, `${label}不能是空的。`);

const seatInput = z
  .object({
    displayName: nonEmpty("席位名"),
    role: nonEmpty("角色"),
    systemPrompt: z.string(),
    backend,
    isSecretary: z.boolean().optional(),
  })
  .strict();

const teamRef = z.object({ teamId: z.string() }).strict();
const libraryItem = z.object({
  label: z.string(),
  id: z.string(),
  status: z.enum(["importable", "already", "refused", "imported"]),
  detail: z.string().optional(),
});
const migrationReport = z.object({
  home: z.string(),
  dryRun: z.boolean(),
  problems: z.array(z.string()),
  teams: z.array(
    z.object({
      teamId: z.string(),
      displayName: z.string(),
      projectFolder: z.string(),
      sittingOf: z.string().optional(),
      lines: z.number(),
      checkpoints: z.number(),
      status: z.enum(["importable", "refused", "already", "newer", "imported", "updated", "failed"]),
      /** For `newer`: how many lines 2.x has said since this session was imported. */
      newLines: z.number().optional(),
      problems: z.array(z.string()),
      notes: z.array(z.string()),
    }),
  ),
  agents: z.array(libraryItem),
  connections: z.array(libraryItem),
  settings: z.array(z.string()),
  criteria: z.object({ files: z.number(), already: z.number(), copied: z.number() }),
});
const backendTool = z.enum(["claude-code", "codex", "dsh"]);
const toolStatus = z.object({
  tool: backendTool,
  command: z.string(),
  installed: z.string().optional(),
  latest: z.string().optional(),
  outdated: z.boolean(),
  method: z.enum(["npm-global", "native", "git-checkout", "unknown"]),
  upgradeCommand: z.string().optional(),
  canUpgrade: z.boolean(),
  problem: z.string().optional(),
});
/** A team built from a plan: what the agent library gained, and the plan's fingerprint. */
const instantiated = z.object({ teamId: z.string(), templateIds: z.array(z.string()), hash: z.string() });

export const methods = {
  /** Which build is running. */
  "app.info": {
    input: z.object({}).strict(),
    output: z.object({ name: z.string(), version: z.string(), platform: z.string(), dataDir: z.string() }),
  },
  /**
   * What starting up found: each backend's CLI (found where a seat would look,
   * or why not), the single-instance lock, and how the teams came back.
   */
  "app.startup": {
    input: z.object({}).strict(),
    output: z.object({
      backends: z.array(z.object({ backend: z.string(), found: z.boolean(), detail: z.string() })),
      lock: z.boolean(),
      teams: z.number(),
      problems: z.array(z.string()),
    }),
  },
  /** Stop every running seat in every team — the tray's 「叫停所有席位」. Returns the teams it stopped. */
  "app.stopAll": { input: z.object({}).strict(), output: z.object({ stopped: z.array(z.string()) }) },
  /** The system folder dialog. `null` is the person cancelling, not a failure. */
  "dialog.pickFolder": {
    input: z.object({}).strict(),
    output: z.object({ path: z.string().nullable() }),
  },
  "teams.list": {
    input: z.object({}).strict(),
    output: z.object({ teams: z.array(teamSummary), problems: z.array(z.string()) }),
  },
  /** Library agents (`members`), hand-written seats (`seats`), or both — members first. */
  "teams.create": {
    input: z
      .object({
        displayName: nonEmpty("团队名"),
        projectFolder: nonEmpty("项目文件夹"),
        members: z
          .array(z.object({ templateId: z.string().trim().min(1), isSecretary: z.boolean().optional() }).strict())
          .optional(),
        seats: z.array(seatInput).optional(),
      })
      .strict()
      .refine((input) => (input.members?.length ?? 0) + (input.seats?.length ?? 0) > 0, "团队至少要有一个席位。"),
    output: z.object({ teamId: z.string() }),
  },
  "teams.rename": {
    input: z.object({ teamId: z.string(), displayName: nonEmpty("团队名") }).strict(),
    output: z.object({}),
  },
  /** A fresh discussion for the same team (same roster, folder, prompts, material). */
  "sessions.open": {
    input: z.object({ teamId: z.string(), name: z.string().optional() }).strict(),
    output: z.object({ teamId: z.string() }),
  },
  /** Blank goes back to 「第 N 场 · 时间」. */
  "sessions.rename": {
    input: z.object({ teamId: z.string(), name: z.string() }).strict(),
    output: z.object({}),
  },
  /** Put one session away; its record stays on disk. Refused for a team's last session. */
  "sessions.close": {
    input: z.object({ teamId: z.string() }).strict(),
    output: z.object({}),
  },
  /** What is archived: whole teams, and single sessions of teams still in use. */
  "archive.list": {
    input: z.object({}).strict(),
    output: z.object({
      teams: z.array(
        z.object({
          teamId: z.string(),
          displayName: z.string(),
          projectFolder: z.string(),
          archivedAt: z.number(),
          sessions: z.array(archivedSession),
        }),
      ),
      sessions: z.array(archivedSession.extend({ teamName: z.string(), groupId: z.string() })),
    }),
  },
  /** Bring back an archived team (with the sessions archived with it) or session. */
  "archive.restore": {
    input: z.object({ teamId: z.string() }).strict(),
    output: z.object({ teamId: z.string() }),
  },
  /** Delete for good: an archived team (all its sessions) or one archived session. */
  "archive.delete": {
    input: z.object({ teamId: z.string() }).strict(),
    output: z.object({}),
  },
  "teams.move": {
    input: z.object({ teamId: z.string(), delta: z.number().int() }).strict(),
    output: z.object({}),
  },
  /** The table goes; what it recorded stays on disk. */
  /**
   * How large the discussion may grow before it folds, as a fraction of the
   * context window (0.05–0.9). `null` goes back to the default. Refused out of
   * range rather than clamped: a number that silently becomes another number
   * is a setting nobody can trust.
   */
  "teams.setCoefficient": {
    input: z
      .object({
        teamId: z.string(),
        coefficient: z.number().min(0.05, "系数不能小于 0.05。").max(0.9, "系数不能大于 0.9。").nullable(),
      })
      .strict(),
    output: z.object({}),
  },
  "teams.disband": {
    input: teamRef,
    output: z.object({}),
  },
  /** From the library (`templateId`), or a bare seat by name and role. */
  "seats.add": {
    input: z
      .object({
        teamId: z.string(),
        templateId: z.string().optional(),
        displayName: z.string().optional(),
        role: z.string().optional(),
        backend: backend.optional(),
        isSecretary: z.boolean().optional(),
      })
      .strict()
      .refine(
        (input) => (input.templateId ?? "").trim() !== "" || (input.displayName ?? "").trim() !== "",
        "要么从 Agent 库里选一个，要么给新席位起个名字。",
      ),
    output: z.object({ seatId: z.string() }),
  },
  /** Its past words stay in the record. Removing the secretary needs `confirmSecretary`. */
  "seats.remove": {
    input: z.object({ teamId: z.string(), seatId: z.string(), confirmSecretary: z.boolean().optional() }).strict(),
    output: z.object({}),
  },
  /** Connection (`""` = the host's own login) and caps, in place. */
  "seats.patch": {
    input: z
      .object({ teamId: z.string(), seatId: z.string(), connectionId: z.string().optional(), caps: caps.optional() })
      .strict(),
    output: z.object({}),
  },
  /** Point a seat at a library agent and take its settings, keeping its place in the roster. */
  "seats.relink": {
    input: z.object({ teamId: z.string(), seatId: z.string(), templateId: z.string() }).strict(),
    output: z.object({}),
  },
  /** Connections, with whether each has a key — never the key. */
  "connections.list": {
    input: z.object({}).strict(),
    output: z.object({ connections: z.array(connectionView) }),
  },
  /** `credential` is written to the vault and never read back. */
  "connections.save": {
    input: z.object({ connection, credential: z.string().optional() }).strict(),
    output: z.object({ connection }),
  },
  "connections.remove": {
    input: z.object({ connectionId: z.string() }).strict(),
    output: z.object({}),
  },
  "agents.list": {
    input: z.object({}).strict(),
    output: z.object({ agents: z.array(agent) }),
  },
  /** Saved, then carried into every team sitting it. `refused` names teams that could not take it now. */
  "agents.save": {
    input: z.object({ agent }).strict(),
    output: z.object({ refused: z.array(z.string()) }),
  },
  /** Soft delete: teams built from it keep their copy. */
  "agents.remove": {
    input: z.object({ templateId: z.string() }).strict(),
    output: z.object({}),
  },
  /** Five answers: backend, CLI, key, endpoint, and one real question (costs a model call; up to 90 s). */
  "agents.check": {
    input: z.object({ templateId: z.string() }).strict(),
    output: z.object({
      templateId: z.string(),
      displayName: z.string(),
      checks: z.array(
        z.object({ name: z.string(), outcome: z.enum(["ok", "fail", "skipped", "unknown"]), detail: z.string() }),
      ),
    }),
  },
  "agents.move": {
    input: z.object({ templateId: z.string(), delta: z.number().int() }).strict(),
    output: z.object({}),
  },
  /**
   * The secretary does one job for the host, off the record: the answer is a
   * draft for the host, not a turn anyone else inherits.
   */
  "secretary.assist": {
    input: z.object({ teamId: z.string(), instruction: nonEmpty("要秘书做的事") }).strict(),
    output: z.object({ text: z.string(), secretary: z.string() }),
  },
  /** The secretary turns the host's sentence into phases. It drafts; nothing runs until the host confirms. */
  "agenda.draft": {
    input: z.object({ teamId: z.string(), command: nonEmpty("要排的事") }).strict(),
    output: z.object({ agendaId: z.string(), revision: z.number() }),
  },
  /** One of the SECRETARY's own replies, turned into a draft. */
  "agenda.fromReply": {
    input: z.object({ teamId: z.string(), entryId: z.string() }).strict(),
    output: z.object({ agendaId: z.string(), revision: z.number() }),
  },
  /** Confirm (runs it; not awaited) or discard the standing draft, naming the revision that was looked at. */
  "agenda.resolve": {
    input: z
      .object({
        teamId: z.string(),
        verdict: z.enum(["confirm", "discard"]),
        agendaId: z.string(),
        revision: z.number(),
        /** The host's edit of the draft. Never a plan nobody proposed. */
        agenda: AgendaSpecSchema.optional(),
        proxy: z.boolean().optional(),
      })
      .strict(),
    output: z.object({}),
  },
  /** Lil X's library: proposals waiting on the person, and what is in force with its health. Evidence by count only. */
  "criteria.list": {
    input: z.object({}).strict(),
    output: z.object({ pending: z.array(criterionView), live: z.array(criterionView), folder: z.string() }),
  },
  /** Adopt (optionally reworded) or refuse a proposal. */
  "criteria.resolve": {
    input: z
      .object({
        id: z.string(),
        verdict: z.enum(["accept", "reject"]),
        claim: z.string().trim().min(1).optional(),
        boundary: z.string().optional(),
      })
      .strict(),
    output: z.object({}),
  },
  /** Stops shaping anything; the file and its reasons stay. */
  "criteria.retire": { input: z.object({ id: z.string() }).strict(), output: z.object({}) },
  /** Back to the queue, to be decided again. */
  "criteria.reopen": { input: z.object({ id: z.string() }).strict(), output: z.object({}) },
  /**
   * 「记下来」 on one of the host's own lines: what the seats proposed since the
   * host last spoke, and what the host made of it, distilled into a proposal.
   */
  "criteria.mark": {
    input: z.object({ teamId: z.string(), entryId: z.string() }).strict(),
    output: z.object({ claim: z.string(), applied: z.boolean(), from: z.array(z.string()) }),
  },
  /** Build the designer team (five seats, five phases as a draft) in an empty folder. */
  "designer.create": {
    input: z.object({ projectFolder: nonEmpty("项目文件夹") }).strict(),
    output: instantiated,
  },
  /** Whether this is a designer team, and which secretary replies are plans — buildable, or refused with why. */
  "designer.status": {
    input: teamRef,
    output: z.object({
      designer: z.boolean(),
      plans: z.array(
        z.union([
          z.object({ entryId: z.string(), ok: z.literal(true) }),
          z.object({ entryId: z.string(), ok: z.literal(false), detail: z.string() }),
        ]),
      ),
    }),
  },
  /** The plan in one secretary reply, checked. */
  "designer.preview": {
    input: z.object({ teamId: z.string(), entryId: z.string() }).strict(),
    output: z.object({ plan: TeamPlanSchema }),
  },
  /** Build that plan — or the host's edit of it, checked whole again — into a new team in an empty folder. */
  "designer.build": {
    input: z
      .object({
        teamId: z.string(),
        entryId: z.string(),
        projectFolder: nonEmpty("项目文件夹"),
        plan: z.unknown().optional(),
      })
      .strict(),
    output: instantiated,
  },
  /** Ask the secretary for the plan again, with the shape and the host's note. */
  "designer.redraft": {
    input: z.object({ teamId: z.string(), note: z.string() }).strict(),
    output: z.object({}),
  },
  /** The five phases put up again on a designer team, as a draft. */
  "designer.agenda": { input: teamRef, output: z.object({}) },
  /** The five seats' prompts brought up to the current seed; the host's own settings kept. */
  "designer.refresh": { input: teamRef, output: z.object({ refreshed: z.array(z.string()) }) },
  /** One chunk read aloud, on the connection and at the speed chosen in settings. MP3, base64. */
  "voice.speak": {
    input: z.object({ text: z.string().trim().min(1), voiceId: z.string().trim().min(1) }).strict(),
    output: z.object({ audio: z.string(), mimeType: z.string() }),
  },
  /** One recording into text, on the connection and model chosen in settings. Audio is base64. */
  "voice.transcribe": {
    input: z.object({ audio: z.string().min(1), mimeType: z.string() }).strict(),
    output: z.object({ text: z.string() }),
  },
  /** The CLIs seats run on: installed and newest versions, and how this machine would upgrade each. */
  "tools.list": { input: z.object({}).strict(), output: z.object({ tools: z.array(toolStatus) }) },
  /** Upgrade one, then prove it still runs. Only the tool is chosen here; the command comes from a closed table. */
  "tools.upgrade": {
    input: z.object({ tool: backendTool }).strict(),
    output: z.object({
      tool: backendTool,
      ok: z.boolean(),
      before: z.string().optional(),
      after: z.string().optional(),
      log: z.string(),
    }),
  },
  /** What importing a Squad 2.x home would do. Writes nothing. `home` defaults to ~/.dsh. */
  "migrate.scan": { input: z.object({ home: z.string().optional() }).strict(), output: migrationReport },
  /** Import what is importable and not in 3 yet; every team read back. 2.x is only read. */
  "migrate.run": { input: z.object({ home: z.string().optional() }).strict(), output: migrationReport },
  "agenda.resume": { input: teamRef, output: z.object({}) },
  "agenda.rewind": {
    input: z.object({ teamId: z.string(), phaseIndex: z.number().int() }).strict(),
    output: z.object({}),
  },
  "agenda.decide": {
    input: z.object({ teamId: z.string(), nodeId: z.string(), decision }).strict(),
    output: z.object({}),
  },
  "agenda.abandon": { input: teamRef, output: z.object({}) },
  /** The system file dialog, then each file read and attached. Refusals are per file, with the reason. */
  "materials.pick": {
    input: teamRef,
    output: z.object({ added: z.array(z.string()), refused: z.array(z.string()) }),
  },
  /** A pasted or dropped file. Bytes as base64: the clipboard has no path. */
  "materials.addBytes": {
    input: z.object({ teamId: z.string(), name: z.string().trim().min(1), base64: z.string() }).strict(),
    output: z.object({ materialId: z.string() }),
  },
  "materials.pin": {
    input: z.object({ teamId: z.string(), materialId: z.string(), pinned: z.boolean() }).strict(),
    output: z.object({}),
  },
  "materials.remove": {
    input: z.object({ teamId: z.string(), materialId: z.string() }).strict(),
    output: z.object({}),
  },
  "blocks.list": {
    input: z.object({}).strict(),
    output: z.object({ blocks: z.array(promptBlock) }),
  },
  "blocks.save": {
    input: z.object({ block: promptBlock }).strict(),
    output: z.object({}),
  },
  /** Soft delete: teams that copied it keep their copy. */
  "blocks.remove": {
    input: z.object({ blockId: z.string() }).strict(),
    output: z.object({}),
  },
  "blocks.reorder": {
    input: z.object({ blockIds: z.array(z.string()) }).strict(),
    output: z.object({}),
  },
  /** A team's shared prompts, the whole shape at once. */
  "teams.setPrompts": {
    input: z.object({ teamId: z.string(), prompts: teamPrompts }).strict(),
    output: z.object({}),
  },
  "settings.get": {
    input: z.object({}).strict(),
    output: settings,
  },
  "settings.save": {
    input: settings,
    output: settings,
  },
  /**
   * The newest lines, or the page before `beforeSeq`. `earlier` counts what is
   * left before the first line returned: a record that starts mid-discussion
   * with nothing saying so reads as the whole discussion.
   */
  "teams.transcript": {
    input: z
      .object({
        teamId: z.string(),
        beforeSeq: z.number().int().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    output: z.object({ lines: z.array(transcriptLine), earlier: z.number() }),
  },
  /** Exactly what one seat was handed for one command — read from the log, not reassembled. */
  "teams.seatRequest": {
    input: z.object({ teamId: z.string(), commandId: z.string(), seatId: z.string() }).strict(),
    output: z.object({ prompt: z.string(), contextLines: z.number() }),
  },
  /** What a seat would be shown if asked now (a fresh conversation's window). For `/squad-window`; nothing is recorded. */
  "teams.window": {
    input: z.object({ teamId: z.string(), seatName: z.string().optional() }).strict(),
    output: z.object({ seatName: z.string(), lines: z.array(z.string()) }),
  },
  /** Send a command. `@名字` addresses seats; none means everyone. Returns once recorded; replies arrive as `team.changed`. */
  "round.say": {
    input: z
      .object({
        teamId: z.string(),
        text: nonEmpty("指令"),
        quoteIds: z.array(z.string()).optional(),
        /** Documents attached to this command; pinned ones ride along anyway. */
        materialIds: z.array(z.string()).optional(),
      })
      .strict(),
    output: z.object({ commandId: z.string() }),
  },
  /** Stop one command, or withdraw it before any seat has started on it. */
  "round.cancel": {
    input: z.object({ teamId: z.string(), commandId: z.string() }).strict(),
    output: z.object({}),
  },
  /** Send an interrupted command again. */
  "round.resend": {
    input: z.object({ teamId: z.string(), commandId: z.string() }).strict(),
    output: z.object({ commandId: z.string() }),
  },
  /** Stop everything this team is running. */
  "round.stop": {
    input: teamRef,
    output: z.object({ stopped: z.boolean() }),
  },
  /** How far the discussion is from the next fold, and the checkpoint standing in for the earlier part. */
  "context.state": {
    input: teamRef,
    output: contextState,
  },
  /** Fold now. */
  "context.fold": {
    input: teamRef,
    output: z.object({ checkpointId: z.string() }),
  },
  /** Retire a checkpoint: the discussion it stood in for comes back into every window. */
  "context.revoke": {
    input: z.object({ teamId: z.string(), checkpointId: z.string() }).strict(),
    output: z.object({}),
  },
} as const;

export type MethodName = keyof typeof methods;
export type MethodInput<M extends MethodName> = z.input<(typeof methods)[M]["input"]>;
export type MethodOutput<M extends MethodName> = z.output<(typeof methods)[M]["output"]>;

export type TeamSummary = z.output<typeof teamSummary>;
export type SeatSummary = z.output<typeof seatSummary>;
export type CommandView = z.output<typeof commandView>;
export type TranscriptLine = z.output<typeof transcriptLine>;
export type SeatInput = z.output<typeof seatInput>;
export type ContextStateView = z.output<typeof contextState>;
export type ConnectionWire = z.output<typeof connection>;
export type ConnectionViewWire = z.output<typeof connectionView>;
export type AgentWire = z.output<typeof agent>;
export type SettingsWire = z.output<typeof settings>;
export type PromptBlockWire = z.output<typeof promptBlock>;
export type AgendaViewWire = z.output<typeof agendaView>;
export type CriterionWire = z.output<typeof criterionView>;
export type DecisionWire = z.output<typeof decision>;
export type TeamPromptsWire = z.output<typeof teamPrompts>;

/** Events the main process pushes. */
export interface PushEvents {
  /** Something about this team changed; re-read it. */
  readonly "team.changed": { readonly teamId: string };
  /** Bring this team up: the person clicked its notification. */
  readonly "team.open": { readonly teamId: string };
}

/**
 * What crosses back to the renderer.
 *
 * A refusal carries the host's own sentence. 「订阅模式不使用自定义端点」 is
 * the whole value of a refusal; a generic 「保存失败」 throws away the only
 * part that says what to do next.
 */
export type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export { EVENT_CHANNEL, INVOKE_CHANNEL } from "./channels.ts";
