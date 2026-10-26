/**
 * seat-runtime — the shared body of the three CLI seat backends.
 *
 * A LIBRARY, not a module: it holds no state and serves no IPC. It is the
 * part of a seat that does not depend on which CLI it is.
 */
export { CommandNotFoundError, findOnPath, resolveCommand, shimTarget } from "./command.ts";
export type { CommandHost, ResolvedCommand } from "./command.ts";
export { failureText } from "./failure.ts";
export {
  isAliveLine,
  isUsageLine,
  SEAT_ALIVE_PREFIX,
  SEAT_USAGE_PREFIX,
  usageFromStderr,
  withoutHeartbeats,
} from "./alive.ts";
export { startChild, TailBuffer } from "./process.ts";
export { downloadMcpConfig } from "./download-tool.ts";
export { DOWNLOAD_SERVER } from "./download-mcp.ts";
export type { ChildExit, ChildSpec, RunningChild } from "./process.ts";
export { deferredRun, refusedRun, runCliSeat } from "./run.ts";
export { COMMAND_SHOWN_CHARS, jsonLineFeeder, shownCommand } from "./tracker.ts";
export type { OpenCommand, StreamTracker } from "./tracker.ts";
export type { CliSeatSpec, SeatActivity, SeatOutcome, SeatResult, SeatRun } from "./run.ts";
export { SEAT_SILENCE_LIMITS, silenceMessage, silenceVerdict, watchSilence } from "./silence.ts";
export {
  forgetSeatSession,
  forgetSeatSessions,
  rememberSeatSession,
  resetSeatSessions,
  restoreSeatSessions,
  resumeWasRejected,
  seatSession,
  seatSessionId,
  snapshotSeatSessions,
  type SeatSession,
} from "./sessions.ts";
export type { SilenceBusy, SilenceLimits, SilenceReason } from "./silence.ts";
