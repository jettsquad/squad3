/**
 * library.ts — the person's connections, agents and settings, as the screens read them.
 *
 * One loader shared by every screen that shows any of it: the agent form
 * lists connections, the roster names them, the create form lists agents. An
 * edit on one screen tells the others to read again, so no screen goes on
 * showing a connection that was just renamed or deleted.
 */
import { useEffect, useState } from "react";
import type { AgentWire, ConnectionViewWire, PromptBlockWire, SettingsWire } from "../../shared/wire.ts";
import { call } from "./api.ts";

export interface LibrarySnapshot {
  readonly connections: readonly ConnectionViewWire[];
  readonly agents: readonly AgentWire[];
  readonly settings: SettingsWire;
  readonly blocks: readonly PromptBlockWire[];
}

const listeners = new Set<() => void>();

/** Tell every screen holding library data to read it again. */
export function libraryChanged(): void {
  for (const listener of listeners) listener();
}

export function useLibrary(): {
  readonly library: LibrarySnapshot | undefined;
  readonly error: string | undefined;
} {
  const [library, setLibrary] = useState<LibrarySnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const listener = (): void => setTick((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [connections, agents, settings, blocks] = await Promise.all([
          call("connections.list", {}),
          call("agents.list", {}),
          call("settings.get", {}),
          call("blocks.list", {}),
        ]);
        if (!live) return;
        setLibrary({ connections: connections.connections, agents: agents.agents, settings, blocks: blocks.blocks });
        setError(undefined);
      } catch (failure) {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => {
      live = false;
    };
  }, [tick]);

  return { library, error };
}

/** A number typed into a box, or nothing when the box is blank. Refused when it is not a positive number. */
export function numberOrUndefined(raw: string): number | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`「${text}」不是一个正数。`);
  return value;
}

export const BACKEND_LABELS: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  dsh: "DeepSeek Harness",
};
