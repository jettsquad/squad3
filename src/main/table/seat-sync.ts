/**
 * seat-sync.ts — carrying an edited agent into the teams already using it.
 *
 * 移植自 Squad 2.x packages/console/src/seat-sync.ts @ 8dcb903
 * 改动：从 console 挪进 table（3 里没有插件墙，桌子自己管名册）；多一个 `templateFacts`，
 * 即 2.x http.ts 里的 `templateFactsOf`。
 *
 * A team's seats are COPIED from the agent library when the team is built.
 * That copy is what a round dispatches on, so editing the agent afterwards
 * changed the library and nothing else: the team kept its old backend, its
 * old connection, its old standing instructions. Every surface showed the new
 * values — the library page, the agent test — while the team ran the old
 * ones. 「改了老成员的属性，感觉都没有更新」 is that, and it is the same
 * shape as every other bug this project keeps finding: stored, rendered,
 * ignored.
 *
 * What is NOT synced is as deliberate as what is: `seatId` (the team's own
 * identity for the chair), `isSecretary` (a decision about this team, not
 * about the agent), and `color` when the seat has one (a team may want two
 * seats from one template told apart). Everything that decides how a seat is
 * DISPATCHED follows the template.
 */
import type { AgentTemplate, PermissionMode } from "../../shared/agent-template.ts";
import type { SeatCaps } from "../../shared/connection.ts";
import type { ReasoningEffort } from "../../shared/reasoning-effort.ts";

/** The seat shape these rules touch. The real `SeatSpec` satisfies it by shape. */
export interface SyncableSeat {
  readonly seatId: string;
  readonly displayName: string;
  readonly role: string;
  readonly systemPrompt: string;
  readonly backend: "claude-code" | "codex" | "dsh";
  readonly connectionId?: string | undefined;
  readonly permissionMode?: PermissionMode | undefined;
  readonly caps?: SeatCaps | undefined;
  readonly color?: string | undefined;
  readonly voiceId?: string | undefined;
  readonly webAccess?: boolean | undefined;
  readonly hostCustomizations?: boolean | undefined;
  readonly subagents?: boolean | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly templateId?: string | undefined;
  readonly isSecretary?: boolean | undefined;
}

/** The template fields a seat mirrors. */
export interface TemplateFacts {
  readonly templateId: string;
  readonly displayName: string;
  readonly role: string;
  readonly systemPrompt: string;
  readonly backend: SyncableSeat["backend"];
  readonly connectionId?: string | undefined;
  readonly permissionMode?: SyncableSeat["permissionMode"];
  readonly caps?: SyncableSeat["caps"];
  readonly color?: string | undefined;
  readonly voiceId?: string | undefined;
  readonly webAccess?: boolean | undefined;
  readonly hostCustomizations?: boolean | undefined;
  readonly subagents?: boolean | undefined;
  readonly reasoningEffort?: ReasoningEffort | undefined;
}

/** The template fields a seat mirrors, read off a library entry. */
export function templateFacts(template: AgentTemplate): TemplateFacts {
  return {
    templateId: template.templateId,
    displayName: template.displayName,
    role: template.role,
    systemPrompt: template.systemPrompt,
    backend: template.backend,
    connectionId: template.connectionId,
    permissionMode: template.permissionMode,
    caps: template.caps,
    color: template.color,
    voiceId: template.voiceId,
    webAccess: template.webAccess,
    hostCustomizations: template.hostCustomizations,
    subagents: template.subagents,
    reasoningEffort: template.reasoningEffort,
  };
}

/** Rebuild one seat from its template, keeping what belongs to the team. */
export function syncSeat<T extends SyncableSeat>(seat: T, template: TemplateFacts): T {
  return {
    ...seat,
    displayName: template.displayName,
    role: template.role,
    systemPrompt: template.systemPrompt,
    backend: template.backend,
    // Assigned rather than spread-when-present: clearing a connection in the
    // library means "run on the host's own login", and a sync that only ever
    // ADDED fields could never carry that.
    ...(template.connectionId === undefined || template.connectionId === ""
      ? { connectionId: undefined }
      : { connectionId: template.connectionId }),
    ...(template.permissionMode === undefined
      ? { permissionMode: undefined }
      : { permissionMode: template.permissionMode }),
    ...(template.caps === undefined ? { caps: undefined } : { caps: template.caps }),
    ...(template.color === undefined ? {} : { color: template.color }),
    ...(template.voiceId === undefined ? {} : { voiceId: template.voiceId }),
    // Assigned rather than added: turning web access OFF in the library has
    // to reach the teams too, and a sync that only ever set `true` could
    // never carry that.
    webAccess: template.webAccess === true,
    // Assigned, not added, for the same reason: unticking 「读取本机配置」 in
    // the library has to reach the seats that are already sitting.
    hostCustomizations: template.hostCustomizations === true,
    // Assigned, not added: turning delegation OFF in the library has to
    // reach the seats already sitting.
    subagents: template.subagents === true,
    // Assigned, not added: going back to 「默认」 in the library has to reach
    // the seats too.
    reasoningEffort: template.reasoningEffort,
  };
}

/** Whether this seat already matches its template in every synced field. */
export function seatMatches(seat: SyncableSeat, template: TemplateFacts): boolean {
  const next = syncSeat(seat, template);
  return (
    next.displayName === seat.displayName &&
    next.role === seat.role &&
    next.systemPrompt === seat.systemPrompt &&
    next.backend === seat.backend &&
    next.connectionId === seat.connectionId &&
    next.permissionMode === seat.permissionMode &&
    next.color === seat.color &&
    next.voiceId === seat.voiceId &&
    next.webAccess === seat.webAccess &&
    next.hostCustomizations === seat.hostCustomizations &&
    // Compared as booleans: a seat saved before this field existed has none,
    // and that is the same as off — not a difference worth a resync.
    (next.subagents === true) === (seat.subagents === true) &&
    next.reasoningEffort === seat.reasoningEffort &&
    next.caps?.maxTurns === seat.caps?.maxTurns &&
    next.caps?.maxCostUsd === seat.caps?.maxCostUsd &&
    next.caps?.maxTokens === seat.caps?.maxTokens
  );
}

/**
 * Which seats of one roster need rebuilding, and what they become.
 *
 * Returned as a plan rather than applied, so the decision is testable without
 * a table or a running team — and so the caller can refuse the whole thing
 * when a round is in flight.
 */
export function planSeatSync<T extends SyncableSeat>(
  seats: readonly T[],
  template: TemplateFacts,
): readonly { readonly at: number; readonly seat: T }[] {
  const plan: { at: number; seat: T }[] = [];
  seats.forEach((seat, at) => {
    if (seat.templateId !== template.templateId) return;
    if (seatMatches(seat, template)) return;
    plan.push({ at, seat: syncSeat(seat, template) });
  });
  return plan;
}
