/**
 * library — what is true of the PERSON, not of any team: connections, the
 * agent library, and settings.
 *
 * 移植自 Squad 2.x packages/connections/src/{service,agent-service,settings-service,block-service}.ts @ 8dcb903
 * 改动：存储从 dsh 的 storage domain 换成数据目录里的三个 JSON 文件；凭据走 3 自己的 vault。
 * 行为照搬：模板软删除、排序整表重写、连接按 id 编辑、凭据只存名字、规则走 shared 里的同一份检查。
 * 新增：设置里多一项 dshCommand（dsh 不在 PATH 上时它在哪）。
 *
 * One owner, several readers: the seat adapters apply a connection's
 * environment, the table copies a template into a seat, the screens edit them.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkAgentTemplate,
  checkConnection,
  credentialRefFor,
  credentialRefProblem,
  envForConnection,
  type AgentTemplate,
  type ConnectionView,
  type PromptBlock,
  type SeatConnection,
} from "../../shared/index.ts";
import { writeJsonAtomic } from "../store/index.ts";
import type { Vault } from "../vault/index.ts";

export interface UserSettings {
  /** What seats call you. */
  readonly hostDisplayName?: string | undefined;
  /** Which connection runs Lil X's distillation (phase 4). Absent means the host's own login. */
  readonly distilConnectionId?: string | undefined;
  /** A system notification when a command finishes (phase 5). Absent means on. */
  readonly notifyOnFinish?: boolean | undefined;
  /** Where dsh is, when it is not on PATH: the executable, or apps/cli/lib/bin.js. */
  readonly dshCommand?: string | undefined;
  /** The window's language. Absent follows the system. */
  readonly language?: "zh" | "en" | undefined;
  /** Light or dark. Absent (or "system") follows the system. */
  readonly theme?: "system" | "light" | "dark" | undefined;
  /** Text size for the whole window, 1 being normal (0.8–1.6). Absent is 1. */
  readonly fontScale?: number | undefined;
  /**
   * Where Lil X keeps the criteria library: plain Markdown files, so it can
   * live in a folder the person keeps under git. Absent is the data folder.
   */
  readonly criteriaFolder?: string | undefined;
  /** Which connection reads replies aloud (MiniMax's speech API), and how fast. Unset means read-aloud is off. */
  readonly speechConnectionId?: string | undefined;
  readonly speechSpeed?: number | undefined;
  /** Which connection turns dictation into text (an OpenAI-compatible transcription service), and its model. */
  readonly dictationConnectionId?: string | undefined;
  readonly dictationModel?: string | undefined;
}

interface Stored<T> {
  readonly version: 1;
  readonly items: Readonly<Record<string, T & { readonly createdAt: number }>>;
}

export interface Library {
  readonly connections: {
    list(): readonly SeatConnection[];
    get(connectionId: string): SeatConnection | undefined;
    /** Validated through the shared rules; an api-key connection with no credential name gets a derived one. */
    save(connection: SeatConnection): SeatConnection;
    remove(connectionId: string): void;
    views(): readonly ConnectionView[];
    setCredential(connectionId: string, value: string): void;
    /** Resolved per call, never cached: a rotated key reaches the next turn. */
    envFor(connectionId: string): Readonly<Record<string, string>>;
  };
  readonly agents: {
    /** Live templates, in the order the library shows them. */
    list(): readonly AgentTemplate[];
    /** Live or not: a team built from a soft-deleted template still needs its name. */
    get(templateId: string): AgentTemplate | undefined;
    save(template: AgentTemplate): void;
    /** Soft delete. */
    remove(templateId: string): void;
    move(templateId: string, delta: number): void;
  };
  readonly settings: {
    get(): UserSettings;
    save(patch: UserSettings): UserSettings;
  };
  /**
   * Reusable prompt fragments (2.x `ctx.promptBlocks`). A team COPIES what it
   * uses, so an edit here reaches the next team and leaves running ones alone.
   */
  readonly blocks: {
    /** Live fragments, in library order. */
    list(): readonly PromptBlock[];
    /** Live or not: a team holding a copy still needs to say where it came from. */
    get(blockId: string): PromptBlock | undefined;
    save(block: PromptBlock): void;
    /** Soft delete. */
    remove(blockId: string): void;
    /** Rewrite the order in one go, so a reorder cannot half-apply. */
    reorder(blockIds: readonly string[]): void;
  };
}

interface BlockRecord extends PromptBlock {
  readonly enabled: boolean;
  readonly order?: number | undefined;
  readonly updatedAt: number;
}

function load<T>(path: string): Record<string, T & { readonly createdAt: number }> {
  if (!existsSync(path)) return {};
  const stored = JSON.parse(readFileSync(path, "utf8")) as Stored<T>;
  if (stored.version !== 1) throw new Error(`「${path}」的版本是 ${String(stored.version)}，这一版只认 1。`);
  return { ...stored.items };
}

export function createLibrary(options: {
  readonly dataDir: string;
  readonly vault: Vault;
  readonly onChanged?: () => void;
}): Library {
  const dir = join(options.dataDir, "library");
  const connectionsFile = join(dir, "connections.json");
  const agentsFile = join(dir, "agents.json");
  const settingsFile = join(dir, "settings.json");
  const blocksFile = join(dir, "blocks.json");
  const changed = (): void => options.onChanged?.();

  const writeItems = <T>(path: string, items: Record<string, T>): void => writeJsonAtomic(path, { version: 1, items });

  const connections: Library["connections"] = {
    list: () =>
      Object.values(load<SeatConnection>(connectionsFile))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(({ createdAt: _createdAt, ...connection }) => connection),
    get: (connectionId) => {
      const found = load<SeatConnection>(connectionsFile)[connectionId];
      if (found === undefined) return undefined;
      const { createdAt: _createdAt, ...connection } = found;
      return connection;
    },
    save: (input) => {
      // A person has a key, not a name for one; the name is bookkeeping the
      // system does for itself (2.x §7.6). Only derived when none was chosen —
      // a chosen name is the "this key is already in my environment" case.
      const connection: SeatConnection =
        input.authMode === "api-key" && (input.credentialRef ?? "").trim() === ""
          ? { ...input, credentialRef: credentialRefFor(input.connectionId) }
          : input;
      const problems = checkConnection(connection);
      if (problems.length > 0) throw new Error(problems.map((problem) => problem.detail).join("\n"));
      const all = load<SeatConnection>(connectionsFile);
      all[connection.connectionId] = {
        ...connection,
        createdAt: all[connection.connectionId]?.createdAt ?? Date.now(),
      };
      writeItems(connectionsFile, all);
      changed();
      return connection;
    },
    remove: (connectionId) => {
      const all = load<SeatConnection>(connectionsFile);
      delete all[connectionId];
      writeItems(connectionsFile, all);
      changed();
    },
    views: () =>
      connections.list().map((connection) => {
        const ref = (connection.credentialRef ?? "").trim();
        if (ref === "") return { ...connection, credentialConfigured: false, credentialWritable: true };
        // One connection with a malformed name is said on that connection,
        // never by failing the whole list: an empty library and an unreadable
        // entry must not look the same. The bad "name" itself is not sent on
        // — it is most often a pasted key.
        const problem = credentialRefProblem(ref);
        if (problem !== undefined) {
          const { credentialRef: _hidden, ...rest } = connection;
          return { ...rest, credentialConfigured: false, credentialWritable: true, credentialProblem: problem };
        }
        const described = options.vault.describe(ref);
        return { ...connection, credentialConfigured: described.configured, credentialWritable: described.writable };
      }),
    setCredential: (connectionId, value) => {
      const connection = connections.get(connectionId);
      if (connection === undefined) throw new Error(`没有这个连接：${connectionId}。`);
      const ref = (connection.credentialRef ?? "").trim();
      if (ref === "") throw new Error("这个连接没有凭据名。");
      options.vault.set(ref, value);
      changed();
    },
    envFor: (connectionId) => {
      const connection = connections.get(connectionId);
      if (connection === undefined) throw new Error(`没有这个连接：${connectionId}。`);
      if (connection.authMode === "subscription") return envForConnection(connection);
      const ref = (connection.credentialRef ?? "").trim();
      return envForConnection(connection, ref === "" ? undefined : options.vault.resolve(ref));
    },
  };

  const agents: Library["agents"] = {
    list: () =>
      Object.values(load<AgentTemplate>(agentsFile))
        .filter((record) => record.enabled)
        .sort(
          (a, b) =>
            (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt,
        )
        .map(({ createdAt: _createdAt, ...template }) => template),
    get: (templateId) => {
      const found = load<AgentTemplate>(agentsFile)[templateId];
      if (found === undefined) return undefined;
      const { createdAt: _createdAt, ...template } = found;
      return template;
    },
    save: (template) => {
      const problems = checkAgentTemplate(template);
      if (problems.length > 0) throw new Error(problems.map((problem) => problem.detail).join("\n"));
      const all = load<AgentTemplate>(agentsFile);
      const existing = all[template.templateId];
      const order = template.order ?? existing?.order;
      // Both are facts about the SHELF, not the agent; an edit form does not
      // carry them, and dropped they would send a saved agent to the end of a
      // list somebody had arranged.
      all[template.templateId] = {
        ...template,
        createdAt: existing?.createdAt ?? Date.now(),
        ...(order === undefined ? {} : { order }),
      };
      writeItems(agentsFile, all);
      changed();
    },
    remove: (templateId) => {
      const all = load<AgentTemplate>(agentsFile);
      const record = all[templateId];
      if (record === undefined) return;
      all[templateId] = { ...record, enabled: false };
      writeItems(agentsFile, all);
      changed();
    },
    move: (templateId, delta) => {
      const ordered = agents.list();
      const at = ordered.findIndex((template) => template.templateId === templateId);
      if (at < 0) throw new Error(`Agent 库里没有这个模板：${templateId}。`);
      const to = at + delta;
      if (to < 0 || to >= ordered.length) return;
      const next = [...ordered];
      const [moved] = next.splice(at, 1);
      if (moved === undefined) return;
      next.splice(to, 0, moved);
      // Every live entry gets a position, not just the two swapped: entries
      // never arranged carry none, and a swap between two of them changes
      // nothing anybody can see.
      const all = load<AgentTemplate>(agentsFile);
      for (const [index, template] of next.entries()) {
        const record = all[template.templateId];
        if (record !== undefined) all[template.templateId] = { ...record, order: index };
      }
      writeItems(agentsFile, all);
      changed();
    },
  };

  const settings: Library["settings"] = {
    get: () => (existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")) as UserSettings) : {}),
    save: (patch) => {
      if (patch.hostDisplayName !== undefined && patch.hostDisplayName.trim() === "") {
        // A blank name reaches a prompt as 「主持人：」 with nothing after it,
        // which reads to a model as a missing field rather than as a person.
        throw new Error("名字不能是空的。");
      }
      const next = { ...settings.get(), ...patch };
      writeJsonAtomic(settingsFile, next);
      changed();
      return next;
    },
  };

  const blockOf = ({ blockId, name, text }: BlockRecord): PromptBlock => ({ blockId, name, text });
  const blocks: Library["blocks"] = {
    list: () =>
      Object.values(load<BlockRecord>(blocksFile))
        .filter((record) => record.enabled)
        .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt))
        .map(blockOf),
    get: (blockId) => {
      const found = load<BlockRecord>(blocksFile)[blockId];
      return found === undefined ? undefined : blockOf(found);
    },
    save: (block) => {
      if (block.name.trim() === "") throw new Error("片段要有名字——它会成为提示词里的小标题。");
      if (block.text.trim() === "") throw new Error("片段正文是空的，挂给谁都不会有效果。");
      const all = load<BlockRecord>(blocksFile);
      const existing = all[block.blockId];
      all[block.blockId] = {
        blockId: block.blockId,
        name: block.name.trim(),
        text: block.text,
        enabled: true,
        ...(existing?.order === undefined ? {} : { order: existing.order }),
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      writeItems(blocksFile, all);
      changed();
    },
    remove: (blockId) => {
      const all = load<BlockRecord>(blocksFile);
      const record = all[blockId];
      if (record === undefined) return;
      all[blockId] = { ...record, enabled: false, updatedAt: Date.now() };
      writeItems(blocksFile, all);
      changed();
    },
    reorder: (blockIds) => {
      const all = load<BlockRecord>(blocksFile);
      for (const [index, blockId] of blockIds.entries()) {
        const record = all[blockId];
        if (record !== undefined) all[blockId] = { ...record, order: index };
      }
      writeItems(blocksFile, all);
      changed();
    },
  };

  return { connections, agents, settings, blocks };
}
