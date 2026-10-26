/**
 * api.ts — the renderer's half of the one IPC channel.
 */
import { useEffect, useState } from "react";
import type { MethodInput, MethodName, MethodOutput } from "../../shared/wire.ts";

/** Call the main process; a refusal becomes an Error carrying the host's own sentence. */
export async function call<M extends MethodName>(method: M, payload: MethodInput<M>): Promise<MethodOutput<M>> {
  if ((window as Partial<Window>).squad === undefined) {
    throw new Error("界面和主进程之间的桥（window.squad）不存在：preload 没有加载成功。");
  }
  const reply = await window.squad.invoke(method, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

/** Re-render whenever the main process says this team (or any team, for `undefined`) changed. */
export function useTeamChanges(teamId: string | undefined): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if ((window as Partial<Window>).squad === undefined) return undefined;
    return window.squad.on((name, data) => {
      if (name !== "team.changed") return;
      const changed = (data as { teamId?: unknown }).teamId;
      if (teamId === undefined || changed === teamId) setTick((value) => value + 1);
    });
  }, [teamId]);
  return tick;
}

/** Run an action, keeping its refusal for display instead of dropping it. */
export function useAction(): {
  readonly error: string | undefined;
  readonly busy: boolean;
  readonly run: <T>(work: () => Promise<T>) => Promise<T | undefined>;
} {
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const run = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    setError(undefined);
    setBusy(true);
    try {
      return await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}
