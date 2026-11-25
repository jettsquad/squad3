/**
 * seats — the adapters, one per backend, behind one interface.
 */
import { existsSync, readFileSync } from "node:fs";
import { refusedRun, resolveCommand, type CommandHost, type ResolvedCommand } from "../seat-runtime/index.ts";
import { createClaudeCodeAdapter } from "./claude-code/adapter.ts";
import { createCodexAdapter } from "./codex/adapter.ts";
import { createDshAdapter } from "./dsh/adapter.ts";
import type { SeatAdapter } from "./types.ts";
import { createCloudAdapter, readCloudQuota } from "./cloud/adapter.ts";
import { activateCloudDevice, cloudDeviceStatus, cloudSubscription } from "./cloud/pairing.ts";
import { cloudExecutions } from "./cloud/executions.ts";
import { connectionCompatibility, type SeatConnection } from "../../shared/connection.ts";
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
  let activating: Promise<SeatConnection> | undefined;
  const cloud = createCloudAdapter({
    stateDir: options.stateDir,
    resolve,
    active,
    approveComputer: options.approveComputer,
  });
  for (const [harness, adapter] of adapters)
    adapters.set(harness, {
      ...adapter,
      start: (request) => {
        const source = request.connection?.connection;
        if (source === undefined) return adapter.start(request);
        const problem = connectionCompatibility(harness, source);
        if (problem !== undefined) return refusedRun(problem);
        return source.source === "octopus" ? cloud.start(request) : adapter.start(request);
      },
    });
  return {
    executions: cloudExecutions(options.stateDir, active),
    quota: (connection: SeatConnection) => readCloudQuota(connection, resolve),
    activate: () =>
      (activating ??= activateCloudDevice(options.stateDir, resolve).finally(() => {
        activating = undefined;
      })),
    subscription: (connection: SeatConnection, term?: "month" | "year") => cloudSubscription(connection, resolve, term),
    deviceStatus: (connection: SeatConnection) => cloudDeviceStatus(connection, resolve),
    adapterFor: (backend: string) =>
      adapters.get(backend) ??
      // Said, not hidden: a backend the form offers but no adapter serves is
      // exactly the 2.x failure 「存得下、显示得出、然后被忽略」.
      `没有「${backend}」后端的席位适配器。`,
  };
}
