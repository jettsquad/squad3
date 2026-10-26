/**
 * preload — the only bridge, and it has exactly two functions.
 *
 * Nothing feature-specific lives here. A new method is a row in `wire.ts` and
 * a handler in the main process; this file does not change.
 */
import { contextBridge, ipcRenderer } from "electron";
// Not from wire.ts: that would pull zod into a sandboxed preload, which cannot require it.
import { EVENT_CHANNEL, INVOKE_CHANNEL } from "../shared/channels.ts";
import type { SquadBridge } from "./bridge.ts";

const bridge: SquadBridge = {
  invoke: (method, payload) => ipcRenderer.invoke(INVOKE_CHANNEL, method, payload),
  on: (handler) => {
    const listener = (_event: unknown, name: string, data: unknown): void => handler(name, data);
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
  },
};

contextBridge.exposeInMainWorld("squad", bridge);
