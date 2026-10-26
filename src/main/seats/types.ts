/**
 * types.ts — the one interface the table knows a seat by (design doc §5).
 *
 * The table never learns which CLI it is talking to. It hands a request to an
 * adapter and gets back a run that settles with a result. That is the whole
 * point of Squad 3: Claude Code, Codex and dsh are peers behind this line.
 */
import type { SeatConnection } from "../../shared/connection.ts";
import type { SeatSpec } from "../../shared/seat.ts";
import type { ResolvedCommand, SeatActivity, SeatRun } from "../seat-runtime/index.ts";

/**
 * The connection a seat runs on, looked up AT START: an edited model or a
 * rotated key reaches the very next turn (2.x `liveConnection`).
 */
export interface ResolvedConnection {
  readonly connection: SeatConnection;
  /** What `envForConnection` produced, the key already resolved from the vault. */
  readonly env: Readonly<Record<string, string>>;
}

export interface SeatRequest {
  readonly seat: SeatSpec;
  /** Absent means the host's own CLI login with the backend's default model. */
  readonly connection?: ResolvedConnection | undefined;
  /** The team's project folder. */
  readonly cwd: string;
  /** The whole task, already assembled. */
  readonly prompt: string;
  /**
   * Standing instructions to append to the CLI's own system prompt. Only sent
   * to an adapter whose `capabilities.persona` is true; the caller folds them
   * into the prompt otherwise (see secretary/persona.ts).
   */
  readonly persona?: string | undefined;
  /** Continue this CLI conversation instead of opening a new one. */
  readonly resumeId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onActivity?: ((activity: SeatActivity) => void) | undefined;
}

export interface SeatCapabilities {
  /** Takes standing instructions separately from the task. */
  readonly persona: boolean;
  /** Can continue a conversation it reported in an earlier result. */
  readonly resume: boolean;
}

export interface SeatAdapter {
  readonly backend: SeatSpec["backend"];
  /**
   * Declared honestly. A request carrying something the adapter does not
   * support is refused by the caller, not accepted and quietly dropped.
   */
  readonly capabilities: SeatCapabilities;
  /** One turn: a fresh process, gone when it finishes. Never throws. */
  start(request: SeatRequest): SeatRun;
  /**
   * Find the CLI exactly as `start` would, or throw saying why not. For the
   * agent test: a test that looked somewhere else than the seat does is a
   * test that passes while the round fails.
   */
  locate?(): ResolvedCommand;
}
