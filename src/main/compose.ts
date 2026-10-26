/**
 * compose.ts — the composition root: every module built here, in dependency order.
 *
 * Replaces 2.x's cordis plugin tree (design doc §4.1). Squad 3 has a fixed set
 * of modules and no third-party plugins, so the order is written out instead
 * of declared through `inject`.
 *
 * The context layer and the table need each other — the table asks for
 * windows, the context layer asks which commands are open — so the context
 * layer reads the table through a late-bound function. The arrow that matters
 * still runs one way: only the table starts seats.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { captureWindow } from "../shared/capture-window.ts";
import {
  connectionMismatch,
  credentialFrom,
  languageBoostFor,
  parseAgendaSpec,
  stripReasoning,
  type AgendaSpec,
  type SeatSpec,
} from "../shared/index.ts";
import { parseMentions } from "../shared/mention.ts";
import { createReasoning, type Criterion } from "./reasoning/index.ts";
import { createAgentCheck } from "./agent-check/index.ts";
import { createContext } from "./context/index.ts";
import { createDesigner } from "./designer/index.ts";
import { createMigrator, type MigrationReport } from "./migrate/index.ts";
import {
  materialFromFile,
  MAX_FILE_BYTES,
  readMedia,
  speak,
  transcribe,
  BACKEND_TOOLS,
  bannerFor,
  createBackendTools,
  quietBanner,
  type Banner,
  type VoiceConnection,
} from "./extras/index.ts";
import type { Handlers } from "./ipc/index.ts";
import { createLibrary } from "./library/index.ts";
import { createVault, type Cipher } from "./vault/index.ts";
import { createSeats, liveCommandResolver, type ResolvedConnection } from "./seats/index.ts";
import { createSecretary } from "./secretary/index.ts";
import { createStore } from "./store/index.ts";
import { createTable, writeReport, type Table } from "./table/index.ts";

/** How many lines the window loads at once, newest first; 「更早的」 brings back as many again. */
const TRANSCRIPT_PAGE = 150;
/** How much of the discussion the secretary reads for a one-off job (2.x read the panel's tail). */
const ASSIST_LINES = 120;

/**
 * An agenda as the distillation reads it: prose rather than JSON, because what
 * differs between a proposed plan and a confirmed one is usually a reworded
 * instruction or a reordered phase, which a diff of objects buries.
 *
 * Who does each task and what the exit check is are in it too (2.x had only
 * the instructions): moving a task to another seat, or tightening a check,
 * is as much a standard as rewording — and an edit of only those read as
 * agreement, so nothing was learnt from it.
 */
function agendaText(agenda: AgendaSpec, seatName: (seatId: string) => string = (seatId) => seatId): string {
  return agenda.phases
    .map((phase, index) =>
      [
        `${index + 1}. ${phase.title}`,
        ...phase.tasks.map((task) => `   ${seatName(task.seatId)}：${task.instruction}`),
        ...(phase.check === undefined ? [] : [`   出口检查：${phase.check.command}`]),
      ].join("\n"),
    )
    .join("\n");
}

/** A criterion for the window: evidence as a count, never the instances. */
function criterionView(
  criterion: Criterion,
  health?: { readonly verdict: string; readonly detail: string },
): {
  id: string;
  claim: string;
  boundary?: string;
  trigger: { action: string[]; features: string[] };
  evidence: number;
  status: Criterion["status"];
  health?: { verdict: string; detail: string };
} {
  return {
    id: criterion.id,
    claim: criterion.claim,
    ...(criterion.boundary === undefined ? {} : { boundary: criterion.boundary }),
    trigger: { action: [...criterion.trigger.action], features: [...criterion.trigger.features] },
    evidence: criterion.evidence.length,
    status: criterion.status,
    ...(health === undefined ? {} : { health: { verdict: health.verdict, detail: health.detail } }),
  };
}

export interface AppEnvironment {
  readonly name: string;
  readonly version: string;
  readonly dataDir: string;
  /** Seals keys in the vault: Electron's `safeStorage` in the app. */
  readonly cipher: Cipher;
  readonly pickFolder: () => Promise<string | null>;
  /** The system file dialog, several at once. Empty when the person cancels. */
  readonly pickFiles: () => Promise<readonly string[]>;
  readonly push: (event: "team.changed" | "team.open", data: { readonly teamId: string }) => void;
  /**
   * Raise a system notification; clicking it brings this team up. Absent in
   * tests and wherever there is no desktop to raise one on.
   */
  readonly notify?: ((banner: Banner, teamId: string) => void) | undefined;
  /** Whether the window is in front of the person right now: no banner for what they are reading. */
  readonly isFocused?: (() => boolean) | undefined;
  /** The window frame follows the chosen theme (the page itself follows it in the renderer). */
  readonly applyTheme?: ((theme: "system" | "light" | "dark") => void) | undefined;
  /** Draw the window larger or smaller: every text in it, titles included. */
  readonly applyFontScale?: ((scale: number) => void) | undefined;
}

export interface Composed {
  readonly handlers: Handlers;
  readonly table: Table;
  /**
   * One picture the window asked to show. Only image files, only inside some
   * team's own project folder — the path came from a model, so it is trusted
   * for nothing.
   */
  readonly readMedia: (path: string) => Promise<{ readonly bytes: Buffer; readonly contentType: string }>;
  /** The tray's 「叫停所有席位」. Returns the teams it stopped. */
  readonly stopEveryTeam: () => readonly string[];
  /** The window's language as chosen in settings; undefined follows the system. */
  readonly language: () => "zh" | "en" | undefined;
  /** Light, dark, or following the system, as chosen in settings. */
  readonly theme: () => "system" | "light" | "dark";
  /** The window's text size as chosen in settings, 1 being normal. */
  readonly fontScale: () => number;
}

/** A report as the wire's mutable arrays accept it. */
function wireReport(report: MigrationReport) {
  return {
    ...report,
    problems: [...report.problems],
    teams: report.teams.map((team) => ({ ...team, problems: [...team.problems], notes: [...team.notes] })),
    agents: report.agents.map((agent) => ({ ...agent })),
    connections: report.connections.map((connection) => ({ ...connection })),
    settings: [...report.settings],
  };
}

export function compose(env: AppEnvironment): Composed {
  const store = createStore(env.dataDir);
  const vault = createVault({ dataDir: env.dataDir, cipher: env.cipher });
  const library = createLibrary({ dataDir: env.dataDir, vault });
  const seats = createSeats({
    stateDir: join(env.dataDir, "seats"),
    // Read at each start: a path fixed in 「设置」 reaches the next turn.
    dshCommand: () => library.settings.get().dshCommand,
  });
  /** Looked up at each turn's start, key resolved: an edited model or a rotated key reaches the very next turn. */
  const resolveConnection = (connectionId: string): ResolvedConnection => {
    const connection = library.connections.get(connectionId);
    if (connection === undefined) throw new Error(`席位用的连接「${connectionId}」已经不在了。`);
    return { connection, env: library.connections.envFor(connectionId) };
  };
  const secretary = createSecretary(seats, {
    connectionFor: (seat) => {
      const connectionId = (seat.connectionId ?? "").trim();
      return connectionId === "" ? undefined : resolveConnection(connectionId);
    },
  });
  const checkAgent = createAgentCheck({ seats, library });
  // The same command a seat of that backend would run — dsh from settings —
  // so the version shown is the version a round uses.
  const backendTools = createBackendTools({
    locate: (tool) => {
      const adapter = seats.adapterFor(tool);
      if (typeof adapter === "string") throw new Error(adapter);
      if (adapter.locate === undefined) throw new Error(`${tool} 的适配器说不出它跑的是哪个命令。`);
      return adapter.locate();
    },
    resolve: liveCommandResolver(),
  });
  const criteriaFolder = (): string => {
    const chosen = (library.settings.get().criteriaFolder ?? "").trim();
    return chosen === "" ? join(env.dataDir, "criteria") : chosen;
  };
  /**
   * Lil X's model calls, on the connection the person chose for it in
   * settings — read per call, so a change takes effect on the next one. A
   * connection that has since been deleted falls back to the host's own login:
   * losing a connection should cost the model choice, not the ability to
   * record what just happened.
   */
  const reasoning = createReasoning({
    root: criteriaFolder,
    run: async (label, prompt, signal) => {
      const connectionId = (library.settings.get().distilConnectionId ?? "").trim();
      const chosen = connectionId === "" ? undefined : library.connections.get(connectionId);
      const seat: SeatSpec = {
        seatId: "lil-x",
        displayName: "Lil X",
        role: label,
        systemPrompt: "",
        backend: chosen?.backend ?? "claude-code",
        ...(chosen === undefined ? {} : { connectionId: chosen.connectionId }),
      };
      const adapter = seats.adapterFor(seat.backend);
      if (typeof adapter === "string") throw new Error(adapter);
      const result = await adapter.start({
        seat,
        ...(chosen === undefined ? {} : { connection: resolveConnection(chosen.connectionId) }),
        cwd: criteriaFolder(),
        prompt,
        ...(signal === undefined ? {} : { signal }),
      }).result;
      if (result.failed || result.cancelled) throw new Error(`${label}没有完成，不采用：${result.text.slice(0, 200)}`);
      return stripReasoning(result.text);
    },
  });
  const changed = (teamId: string): void => env.push("team.changed", { teamId });
  const late: { table?: Table } = {};
  /** Off when the person turned it off, and while the window is in front of them. */
  const wantsBanner = (): boolean => library.settings.get().notifyOnFinish !== false && env.isFocused?.() !== true;
  const tableNow = (): Table => {
    if (late.table === undefined) throw new Error("桌子还没有建好。");
    return late.table;
  };
  const context = createContext({
    store,
    secretary,
    facts: (teamId) => tableNow().facts(teamId),
    onFolded: (teamId) => tableNow().folded(teamId),
    onChanged: changed,
    onAudit: (teamId, kind, detail) => tableNow().note(teamId, kind, detail),
  });
  const built = createTable({
    store,
    seats,
    context,
    onChanged: changed,
    library: {
      template: (templateId) => library.agents.get(templateId),
      hasConnection: (connectionId) => library.connections.get(connectionId),
      resolveConnection,
      hostDisplayName: () => library.settings.get().hostDisplayName,
      block: (blockId) => library.blocks.get(blockId),
    },
    proxy: (point, signal) => reasoning.decide(point, signal),
    // A finished round is the moment someone who looked away wants to hear
    // about. Skipped while the window is in front of them and when they
    // turned it off; `bannerFor` skips the ones that are not a stopping point.
    onRoundEnded: (event) => {
      if (!wantsBanner()) return;
      const banner = bannerFor(event);
      if (banner !== undefined) env.notify?.(banner, event.teamId);
    },
    onQuietAsk: (event) => {
      if (wantsBanner()) env.notify?.(quietBanner(event), event.teamId);
    },
    // The team's own secretary judges its quiet commands — the table never
    // reaches the secretary itself.
    judgeQuiet: (teamId, input, signal) =>
      secretary.judgeQuiet({
        ...input,
        cwd: folderOf(teamId),
        secretary: (late.table as Table).facts(teamId).secretary,
        signal,
      }),
    // A stopped agenda leaves a hand-off: the secretary writes it from what the
    // program knows ran, into the project's .squad/reports/. 2.x had this
    // written and tested with no path that called it.
    onAgendaStopped: (teamId, termination) => {
      void (async () => {
        const facts = built.facts(teamId);
        const text = await secretary.writeTermination({
          ...termination,
          cwd: facts.projectFolder,
          seat: facts.secretary,
        });
        // Local time: the person reads the file name next to the times in the discussion.
        const now = new Date();
        const pad = (value: number): string => String(value).padStart(2, "0");
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        const path = await writeReport(facts.projectFolder, `${teamId}-handoff-${stamp}`, text);
        built.recordNote(teamId, `📝 ${facts.secretary.displayName} 写好了中止交接：${path}`);
      })().catch((error: unknown) => {
        built.recordNote(
          teamId,
          `⚠️ 中止交接没写成：${error instanceof Error ? error.message : String(error)}。议程停在哪、做完了什么，议程卡片上都还在。`,
        );
      });
    },
  });
  late.table = built;
  const designer = createDesigner({ table: built, agents: library.agents });
  const migrator = createMigrator({ store, library, table: built, criteriaFolder });
  /**
   * 「叫停所有席位」 from the tray: every team with something running is
   * stopped the way its own 叫停 button stops it — recorded as a stop, an
   * agenda handed over — not killed as at quit.
   */
  const stopEveryTeam = (): string[] =>
    built
      .list()
      .teams.filter((team) => team.busy || team.agenda.running !== undefined)
      .filter((team) => built.stop(team.teamId).stopped)
      .map((team) => team.displayName);
  /**
   * The connection a voice feature was given in settings, with its key —
   * resolved here so the key never crosses to the window. Refused by name when
   * none is chosen, or the chosen one is gone: 「朗读没反应」 with a deleted
   * connection behind it is the failure this says out loud.
   */
  const voiceConnection = (connectionId: string | undefined, feature: string): VoiceConnection => {
    const id = (connectionId ?? "").trim();
    if (id === "") throw new Error(`还没有选${feature}用的连接。到设置里选一个。`);
    const connection = library.connections.get(id);
    if (connection === undefined) throw new Error(`${feature}用的连接已经不在连接库里了。到设置里重新选一个。`);
    return {
      displayName: connection.displayName,
      endpoint: connection.endpoint,
      credential: credentialFrom(library.connections.envFor(id)),
    };
  };
  /**
   * The host's own standards for the kinds of decision a draft makes, fetched
   * now because now is when they can still change it. Failure costs the
   * briefs, never the draft.
   */
  const briefsFor = async (draft: AgendaSpec): Promise<readonly string[]> => {
    try {
      return (await reasoning.briefForAgenda(draft))
        .filter((entry) => entry.brief.trim() !== "")
        .map((entry) => `【${entry.phase}】\n${entry.brief}`);
    } catch (error) {
      console.warn(`判据简报没取到：${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };
  const summaryOf = (teamId: string) => {
    const team = built.list().teams.find((candidate) => candidate.teamId === teamId);
    if (team === undefined) throw new Error(`没有这支团队：${teamId}`);
    return team;
  };
  /** The team's designated secretary, whole. Judgement work in someone's name: never the fold's fallback. */
  const designatedSecretary = (teamId: string) => {
    if (!summaryOf(teamId).seats.some((seat) => seat.isSecretary)) {
      throw new Error("这支团队没有秘书，排不了议程。到成员面板里指一位。");
    }
    return built.facts(teamId).secretary;
  };
  const folderOf = (teamId: string): string => {
    const team = built.list().teams.find((candidate) => candidate.teamId === teamId);
    if (team === undefined) throw new Error(`没有这支团队：${teamId}`);
    return team.projectFolder;
  };
  /** Every team: a renamed connection or a deleted agent shows on the roster. */
  const changedAll = (): void => {
    for (const team of built.list().teams) changed(team.teamId);
  };

  const handlers: Handlers = {
    "app.info": async () => ({
      name: env.name,
      version: env.version,
      platform: process.platform,
      dataDir: env.dataDir,
    }),
    "app.startup": async () => {
      const listed = built.list();
      return {
        // Where a seat would look — the adapter's own `locate`, dsh from
        // settings — so 「找到了」 here means a round would find it too.
        backends: (["claude-code", "codex", "dsh"] as const).map((backend) => {
          const adapter = seats.adapterFor(backend);
          if (typeof adapter === "string") return { backend, found: false, detail: adapter };
          try {
            const located = adapter.locate?.();
            if (located === undefined) return { backend, found: false, detail: "适配器说不出它跑哪个命令。" };
            return { backend, found: true, detail: [located.file, ...located.prefixArgs].join(" ") };
          } catch (error) {
            return { backend, found: false, detail: error instanceof Error ? error.message : String(error) };
          }
        }),
        // Held, or this process would have quit before getting here (index.ts).
        lock: true,
        teams: listed.teams.length,
        problems: [...listed.problems],
      };
    },
    "app.stopAll": async () => ({ stopped: stopEveryTeam() }),
    "dialog.pickFolder": async () => ({ path: await env.pickFolder() }),
    "teams.list": async () => {
      const { teams, problems } = built.list();
      return { teams: [...teams], problems: [...problems] };
    },
    "teams.create": async (input) => built.create(input),
    "teams.transcript": async ({ teamId, beforeSeq, limit }) => {
      const all = built.transcript(teamId);
      // Asked for by the seq of the oldest line on screen, so a message
      // arriving in between moves nothing (2.x `earlierLines`).
      const end = beforeSeq === undefined ? all.length : all.findIndex((line) => line.seq >= beforeSeq);
      const stop = end < 0 ? all.length : end;
      const from = Math.max(0, stop - (limit ?? TRANSCRIPT_PAGE));
      return { lines: all.slice(from, stop), earlier: from };
    },
    "teams.seatRequest": async ({ teamId, commandId, seatId }) => built.seatRequest(teamId, commandId, seatId),
    "teams.window": async ({ teamId, seatName }) => {
      const team = built.list().teams.find((candidate) => candidate.teamId === teamId);
      if (team === undefined) throw new Error(`没有这支团队：${teamId}`);
      const wanted = (seatName ?? "").trim();
      const seat = wanted === "" ? team.seats[0] : team.seats.find((candidate) => candidate.displayName === wanted);
      if (seat === undefined) throw new Error(`这支团队里没有「${wanted}」。`);
      return { seatName: seat.displayName, lines: [...context.windowFor(teamId)] };
    },
    "round.say": async ({ teamId, text, quoteIds, materialIds }) => built.say(teamId, text, quoteIds, materialIds),
    "secretary.assist": async ({ teamId, instruction }) => {
      const team = built.list().teams.find((candidate) => candidate.teamId === teamId);
      if (team === undefined) throw new Error(`没有这支团队：${teamId}`);
      // A designated secretary, not the fold's fallback: this is judgement
      // work done in someone's name, and the team should know whose.
      if (!team.seats.some((seat) => seat.isSecretary)) throw new Error("这支团队没有秘书。到成员面板里指一位。");
      const seat = built.facts(teamId).secretary;
      const text = await secretary.assist({
        cwd: team.projectFolder,
        seat,
        instruction,
        topic: team.displayName,
        // What the team can see and nothing else, in the same order.
        discussion: built
          .transcript(teamId)
          .filter((line) => line.kind === "host" || line.kind === "seat")
          .slice(-ASSIST_LINES)
          .map((line) => ({ speaker: line.speaker, text: line.text })),
        seats: team.seats.map((one) => ({ displayName: one.displayName, role: one.role })),
      });
      return { text, secretary: seat.displayName };
    },
    "agenda.draft": async ({ teamId, command }) => {
      const team = summaryOf(teamId);
      const seat = designatedSecretary(teamId);
      const draft = await secretary.draftAgenda({
        cwd: team.projectFolder,
        seat,
        command,
        topic: team.displayName,
        seats: team.seats.map((one) => ({ seatId: one.seatId, displayName: one.displayName })),
      });
      return built.setDraft(teamId, draft, { criteria: await briefsFor(draft) });
    },
    "agenda.fromReply": async ({ teamId, entryId }) => {
      const team = summaryOf(teamId);
      const seat = designatedSecretary(teamId);
      const line = built.transcript(teamId).find((one) => one.entryId === entryId);
      if (line === undefined) throw new Error("找不到这条回复。");
      // Only the secretary's own reply: converting another member's would let
      // that member schedule the team while the confirmation says the secretary did.
      if (line.kind !== "seat" || line.seatId !== seat.seatId) {
        throw new Error(`只能把秘书（${seat.displayName}）自己的回复转成议程，这条是${line.speaker}说的。`);
      }
      const draft = await secretary.agendaFromReply({
        cwd: team.projectFolder,
        seat,
        reply: line.text,
        command: "把上面这段安排转成结构化议程。",
        topic: team.displayName,
        seats: team.seats.map((one) => ({ seatId: one.seatId, displayName: one.displayName })),
      });
      return built.setDraft(teamId, draft, { fromEntryId: entryId, criteria: await briefsFor(draft) });
    },
    "agenda.resolve": async ({ teamId, verdict, agendaId, revision, agenda, proxy }) => {
      // Parsed again here for its OUTPUT shape (defaults filled in), the shape the table runs.
      const edited = agenda === undefined ? undefined : parseAgendaSpec(agenda);
      const team = summaryOf(teamId);
      const proposed = team.agenda.draft?.agenda;
      built.resolveAgenda(teamId, { kind: verdict, agendaId, revision, agenda: edited, proxy });
      // An EDITED confirmation is a veto with both halves on the table: the
      // secretary proposed one plan, the host confirmed another, and the
      // difference is the standard. Unchanged is agreement, and recording
      // agreement as overruling would fill the library with criteria nobody
      // held. Fire-and-forget: confirmed work must not wait on a model call.
      if (verdict === "confirm" && edited !== undefined && proposed !== undefined) {
        const names = new Map(team.seats.map((seat) => [seat.seatId, seat.displayName]));
        const seatName = (seatId: string): string => names.get(seatId) ?? seatId;
        const before = agendaText(proposed, seatName);
        const after = agendaText(edited, seatName);
        if (before !== after) {
          void reasoning
            .capture({
              kind: "veto",
              situation: { action: "adjudicate", features: [] },
              proposed: before,
              verdict: after,
              project: team.projectFolder,
            })
            // Said in the team, not only logged: a library that silently missed
            // what you just overruled looks exactly like one that had nothing to learn.
            .catch((error: unknown) =>
              built.recordNote(
                teamId,
                `Lil X 没能把你对这份草案的改动记成判据：${error instanceof Error ? error.message : String(error)}`,
              ),
            );
        }
      }
      return {};
    },
    "criteria.list": async () => {
      const healthById = new Map((await reasoning.health()).map((entry) => [entry.criterionId, entry]));
      return {
        pending: (await reasoning.pending()).map((criterion) => criterionView(criterion)),
        live: (await reasoning.criteria()).map((criterion) => criterionView(criterion, healthById.get(criterion.id))),
        folder: criteriaFolder(),
      };
    },
    "criteria.resolve": async ({ id, verdict, claim, boundary }) => {
      const proposal = (await reasoning.pending()).find((candidate) => candidate.id === id);
      const edited =
        proposal !== undefined && verdict === "accept" && (claim !== undefined || boundary !== undefined)
          ? {
              ...proposal,
              ...(claim === undefined ? {} : { claim }),
              ...(boundary === undefined ? {} : boundary.trim() === "" ? { boundary: undefined } : { boundary }),
            }
          : undefined;
      await reasoning.resolve(id, verdict, edited);
      return {};
    },
    "criteria.retire": async ({ id }) => {
      await reasoning.retire(id);
      return {};
    },
    "criteria.reopen": async ({ id }) => {
      await reasoning.reopen(id);
      return {};
    },
    "migrate.scan": async ({ home }) => wireReport(migrator.scan(home)),
    "migrate.run": async ({ home }) => {
      const report = migrator.run(home);
      // The library changed underneath every open view.
      changedAll();
      return wireReport(report);
    },
    "tools.list": async () => ({
      tools: await Promise.all(BACKEND_TOOLS.map((tool) => backendTools.inspect(tool))),
    }),
    "tools.upgrade": async ({ tool }) => backendTools.upgrade(tool),
    "voice.speak": async ({ text, voiceId }) => {
      const chosen = library.settings.get();
      const audio = await speak(voiceConnection(chosen.speechConnectionId, "朗读"), {
        text,
        voiceId,
        speed: chosen.speechSpeed ?? 1,
        languageBoost: languageBoostFor(voiceId),
      });
      return { audio: audio.toString("base64"), mimeType: "audio/mpeg" };
    },
    "voice.transcribe": async ({ audio, mimeType }) => {
      const chosen = library.settings.get();
      const text = await transcribe(voiceConnection(chosen.dictationConnectionId, "听写"), {
        audio: Buffer.from(audio, "base64"),
        mimeType,
        model: chosen.dictationModel ?? "",
      });
      return { text };
    },
    "designer.create": async ({ projectFolder }) => {
      const { teamId, templateIds, hash } = designer.createDesignerTeam(projectFolder);
      return { teamId, templateIds: [...templateIds], hash };
    },
    "designer.status": async ({ teamId }) => {
      const { designer: isDesigner, plans } = designer.status(teamId);
      return { designer: isDesigner, plans: plans.map((plan) => ({ ...plan })) };
    },
    "designer.preview": async ({ teamId, entryId }) => ({ plan: designer.preview(teamId, entryId) }),
    "designer.build": async ({ teamId, entryId, projectFolder, plan }) => {
      const result = designer.build(teamId, entryId, projectFolder, plan);
      return { teamId: result.teamId, templateIds: [...result.templateIds], hash: result.hash };
    },
    "designer.redraft": async ({ teamId, note }) => {
      designer.redraft(teamId, note);
      return {};
    },
    "designer.agenda": async ({ teamId }) => {
      designer.placeAgenda(teamId);
      return {};
    },
    "designer.refresh": async ({ teamId }) => ({ refreshed: [...designer.refresh(teamId)] }),
    "criteria.mark": async ({ teamId, entryId }) => {
      const team = summaryOf(teamId);
      // Built from the RECORD, never from the window: an instance is the
      // evidence a criterion rests on, and only what the record says was said
      // may reach the library.
      const spoken = built.transcript(teamId).filter((line) => line.kind === "host" || line.kind === "seat");
      // An agenda step is under the host's name but in the agenda's words:
      // a standard distilled from it would be the secretary's, filed as yours.
      const target = spoken.find((line) => line.entryId === entryId);
      if (target?.sentFor !== undefined) {
        throw new Error("这条是程序替你发给秘书的请求，不是你自己说的话——「记下来」只挂在你亲口说的话上。");
      }
      if (target?.agendaPhase !== undefined) {
        throw new Error("这是议程替你发出的指令，不是你自己说的话——「记下来」只挂在你亲口说的话上。");
      }
      const lines = spoken.map((line) => ({ speaker: line.speaker, text: line.text, turnId: line.entryId }));
      const marked = lines.find((line) => line.turnId === entryId);
      if (marked === undefined) throw new Error("找不到这条发言。");
      const named = parseMentions(
        marked.text,
        team.seats.map((seat) => seat.displayName),
      ).named;
      const window = captureWindow(lines, team.hostDisplayName, entryId, named);
      if (window === undefined) {
        throw new Error(`「记下来」只挂在${team.hostDisplayName}自己的发言上——判据是你的标准，不是别人的观点。`);
      }
      const captured = await reasoning.capture({
        kind: "explicit-mark",
        situation: { action: "adjudicate", features: [] },
        proposed: window.proposed,
        verdict: window.verdict,
        project: team.projectFolder,
      });
      return { claim: captured.proposal.claim, applied: captured.applied, from: [...window.from] };
    },
    "agenda.resume": async ({ teamId }) => {
      built.resumeAgenda(teamId);
      return {};
    },
    "agenda.rewind": async ({ teamId, phaseIndex }) => {
      built.rewindAgenda(teamId, phaseIndex);
      return {};
    },
    "agenda.decide": async ({ teamId, nodeId, decision }) => {
      built.decideNode(teamId, nodeId, decision);
      return {};
    },
    "agenda.abandon": async ({ teamId }) => {
      built.abandonAgenda(teamId);
      return {};
    },
    "materials.pick": async ({ teamId }) => {
      const folder = folderOf(teamId);
      const paths = await env.pickFiles();
      const added: string[] = [];
      const refused: string[] = [];
      // One at a time and each on its own: one unreadable PDF must not take
      // the other four down with it, and each refusal names its file.
      for (const path of paths) {
        const name = basename(path);
        try {
          const size = (await stat(path)).size;
          if (size > MAX_FILE_BYTES)
            throw new Error(`「${name}」有 ${(size / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限。`);
          built.addMaterial(teamId, await materialFromFile(folder, name, await readFile(path)));
          added.push(name);
        } catch (error) {
          refused.push(error instanceof Error ? error.message : String(error));
        }
      }
      return { added, refused };
    },
    "materials.addBytes": async ({ teamId, name, base64 }) => {
      const bytes = Buffer.from(base64, "base64");
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`「${name}」超过 20MB 上限。`);
      return built.addMaterial(teamId, await materialFromFile(folderOf(teamId), name, bytes));
    },
    "materials.pin": async ({ teamId, materialId, pinned }) => {
      built.setMaterialPinned(teamId, materialId, pinned);
      return {};
    },
    "materials.remove": async ({ teamId, materialId }) => {
      built.removeMaterial(teamId, materialId);
      return {};
    },
    "round.cancel": async ({ teamId, commandId }) => {
      built.cancel(teamId, commandId);
      return {};
    },
    "round.resend": async ({ teamId, commandId }) => built.resend(teamId, commandId),
    "round.stop": async ({ teamId }) => built.stop(teamId),
    "context.state": async ({ teamId }) => {
      built.facts(teamId);
      const state = context.state(teamId);
      return { ...state, history: [...state.history] };
    },
    "context.fold": async ({ teamId }) => {
      built.facts(teamId);
      const recorded = await context.fold(teamId);
      return { checkpointId: recorded.checkpointId };
    },
    "context.revoke": async ({ teamId, checkpointId }) => {
      built.facts(teamId);
      context.revoke(teamId, checkpointId);
      return {};
    },
    "teams.rename": async ({ teamId, displayName }) => {
      built.rename(teamId, displayName);
      return {};
    },
    "teams.move": async ({ teamId, delta }) => {
      built.move(teamId, delta);
      return {};
    },
    "sessions.open": async ({ teamId, name }) => built.openSession(teamId, name),
    "archive.list": async () => {
      const view = built.archive();
      return {
        teams: view.teams.map((team) => ({ ...team, sessions: team.sessions.map((one) => ({ ...one })) })),
        sessions: view.sessions.map((one) => ({ ...one })),
      };
    },
    "archive.restore": async ({ teamId }) => built.restore(teamId),
    "archive.delete": async ({ teamId }) => {
      built.remove(teamId);
      return {};
    },
    "sessions.rename": async ({ teamId, name }) => {
      built.renameSession(teamId, name);
      return {};
    },
    "sessions.close": async ({ teamId }) => {
      built.closeSession(teamId);
      return {};
    },
    "teams.setCoefficient": async ({ teamId, coefficient }) => {
      built.setCoefficient(teamId, coefficient ?? undefined);
      return {};
    },
    "teams.disband": async ({ teamId }) => {
      built.disband(teamId);
      return {};
    },
    "seats.add": async (input) => built.addSeat(input.teamId, input),
    "seats.remove": async ({ teamId, seatId, confirmSecretary }) => {
      built.removeSeat(teamId, seatId, confirmSecretary === undefined ? {} : { confirmSecretary });
      return {};
    },
    "seats.patch": async ({ teamId, seatId, connectionId, caps }) => {
      built.patchSeat(teamId, seatId, { connectionId, caps });
      return {};
    },
    "seats.relink": async ({ teamId, seatId, templateId }) => {
      built.relinkSeat(teamId, seatId, templateId);
      return {};
    },
    "connections.list": async () => ({ connections: [...library.connections.views()] }),
    "connections.save": async ({ connection, credential }) => {
      // The connection first: a key with nowhere to go would be stored under
      // a name nothing reads.
      const saved = library.connections.save(connection);
      if (credential !== undefined && credential.trim() !== "") {
        library.connections.setCredential(saved.connectionId, credential.trim());
      }
      changedAll();
      return { connection: saved };
    },
    "connections.remove": async ({ connectionId }) => {
      // Refused while anything points at it: removed, it would surface at the
      // next round as a seat that cannot start.
      const users = [
        ...library.agents
          .list()
          .filter((agent) => agent.connectionId === connectionId)
          .map((agent) => `Agent「${agent.displayName}」`),
        ...built
          .list()
          .teams.flatMap((team) =>
            team.seats
              .filter((seat) => seat.connectionId === connectionId)
              .map((seat) => `「${team.displayName}」的${seat.displayName}`),
          ),
      ];
      if (users.length > 0) throw new Error(`还有人在用这个连接：${users.join("、")}。先给它们换一个连接。`);
      const connection = library.connections.get(connectionId);
      library.connections.remove(connectionId);
      const ref = (connection?.credentialRef ?? "").trim();
      if (ref !== "" && vault.describe(ref).source === "vault") vault.remove(ref);
      return {};
    },
    "agents.list": async () => ({ agents: [...library.agents.list()] }),
    "agents.save": async ({ agent }) => {
      // Refused at save, where it can still be fixed cheaply. Left to run
      // time it is a seat that cannot start, at the first round.
      const connectionId = (agent.connectionId ?? "").trim();
      if (connectionId !== "") {
        const linked = library.connections.get(connectionId);
        if (linked === undefined) throw new Error(`没有这个连接：${connectionId}。`);
        const problem = connectionMismatch(agent.backend, linked.backend, linked.displayName);
        if (problem !== undefined) throw new Error(problem);
      }
      const template = { ...agent, connectionId: connectionId === "" ? undefined : connectionId };
      library.agents.save(template);
      // And into every team already sitting this agent. Without this the
      // library and the teams disagree from the moment of the first edit.
      return { refused: [...built.syncTemplate(library.agents.get(template.templateId) ?? template)] };
    },
    "agents.remove": async ({ templateId }) => {
      library.agents.remove(templateId);
      changedAll();
      return {};
    },
    "agents.check": async ({ templateId }) => {
      const report = await checkAgent(templateId);
      return { ...report, checks: [...report.checks] };
    },
    "agents.move": async ({ templateId, delta }) => {
      library.agents.move(templateId, delta);
      return {};
    },
    "blocks.list": async () => ({ blocks: [...library.blocks.list()] }),
    "blocks.save": async ({ block }) => {
      library.blocks.save(block);
      // Teams show which of their copies differ from the library.
      changedAll();
      return {};
    },
    "blocks.remove": async ({ blockId }) => {
      library.blocks.remove(blockId);
      return {};
    },
    "blocks.reorder": async ({ blockIds }) => {
      library.blocks.reorder(blockIds);
      return {};
    },
    "teams.setPrompts": async ({ teamId, prompts }) => {
      built.setPrompts(teamId, prompts);
      return {};
    },
    "settings.get": async () => library.settings.get(),
    "settings.save": async (patch) => {
      const saved = library.settings.save(patch);
      if (patch.theme !== undefined) env.applyTheme?.(patch.theme);
      if (patch.fontScale !== undefined) env.applyFontScale?.(patch.fontScale);
      return saved;
    },
  };
  const readTeamMedia = async (path: string): Promise<{ readonly bytes: Buffer; readonly contentType: string }> => {
    let last: unknown = new Error("没有团队。");
    for (const team of built.list().teams) {
      try {
        return await readMedia(team.projectFolder, path);
      } catch (error) {
        last = error;
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  };
  return {
    handlers,
    table: built,
    readMedia: readTeamMedia,
    stopEveryTeam,
    language: () => library.settings.get().language,
    theme: () => library.settings.get().theme ?? "system",
    fontScale: () => library.settings.get().fontScale ?? 1,
  };
}
