/** The shape of `window.squad`, shared by the preload that builds it and the renderer that uses it. */
import type { MethodInput, MethodName, MethodOutput, Reply } from "../shared/wire.ts";

export interface SquadBridge {
  invoke<M extends MethodName>(method: M, payload: MethodInput<M>): Promise<Reply<MethodOutput<M>>>;
  /** Subscribe to pushed events. Returns the unsubscribe function. */
  on(handler: (name: string, data: unknown) => void): () => void;
}

declare global {
  interface Window {
    readonly squad: SquadBridge;
  }
}
