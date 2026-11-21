/**
 * seats — the adapters, one per backend, behind one interface.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolveCommand, type CommandHost, type ResolvedCommand } from "../seat-runtime/index.ts";
import { createClaudeCodeAdapter } from "./claude-code/adapter.ts";
import { createCodexAdapter } from "./codex/adapter.ts";
import { createDshAdapter } from "./dsh/adapter.ts";
import type { SeatAdapter } from "./types.ts";
import { createCloudAdapter, readCloudQuota } from "./cloud/adapter.ts";
import { cloudExecutions } from "./cloud/executions.ts";
import type { SeatConnection } from "../../shared/connection.ts";
import type { ComputerApproval } from "./cloud/computer.ts";

export type { ResolvedConnection, SeatAdapter, SeatCapabilities, SeatRequest } from "./types.ts";

export interface Seats {
  /** The adapter for a backend, or a sentence saying it is not there. */
  adapterFor(backend: string): SeatAdapter | string;
}

/** Commands are resolved against the live environment at each start, so a CLI installed while Squad runs is found. */
export function liveCommandResolver(): (name: string) => ResolvedCommand {
  const host = (): CommandHost => ({
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    readText: (path) => readFileSync(path, "utf8"),
    execPath: process.execPath,
  });
  return (name) => resolveCommand(name, host());
}

export interface SeatsOptions {
  /** Where adapters keep files they generate (the dsh heartbeat module). */
  readonly stateDir: string;
  readonly resolve?: (name: string) => ResolvedCommand;
  /** The dsh path from settings, read at each start. */
  readonly dshCommand?: () => string | undefined;
  readonly approveComputer?: ComputerApproval | undefined;
}

export function createSeats(options: SeatsOptions) {
  const resolve = options.resolve ?? liveCommandResolver();
  const adapters = new Map<string, SeatAdapter>([
    ["claude-code", createClaudeCodeAdapter(resolve, options.stateDir)],
    ["codex", createCodexAdapter(resolve)],
    ["dsh", createDshAdapter({ resolve, stateDir: options.stateDir, configuredCommand: options.dshCommand })],
  ]);
  const active = new Set<string>();
  const cloud = createCloudAdapter({
    stateDir: options.stateDir,
    resolve,
    active,
    approveComputer: options.approveComputer,
  });
  const localCodex = adapters.get("codex");
  if (localCodex !== undefined)
    adapters.set("codex", {
      ...localCodex,
      // Same capabilities as local Codex: all existing callers, including secretary and Lil X,
      // select the source on the live resolved connection at start, without duplicating routing.
      start: (request) =>
        request.connection?.connection.source === "octopus" ? cloud.start(request) : localCodex.start(request),
    });
  return {
    executions: cloudExecutions(options.stateDir, active),
    quota: (connection: SeatConnection) => readCloudQuota(connection, resolve),
    adapterFor: (backend: string) =>
      adapters.get(backend) ??
      // Said, not hidden: a backend the form offers but no adapter serves is
      // exactly the 2.x failure 「存得下、显示得出、然后被忽略」.
      `没有「${backend}」后端的席位适配器。`,
  };
}
