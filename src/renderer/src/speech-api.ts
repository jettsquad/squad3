/**
 * speech-api.ts — the two voice calls, as the window uses them.
 *
 * Its own module so the player can be tested with these two replaced and
 * nothing else; the key stays on the main process either way.
 */
import type { MethodInput, MethodName, MethodOutput } from "../../shared/wire.ts";

/**
 * The bridge, reached directly rather than through `api.ts`: this module is
 * also loaded by the player's test under the Node type-check, which has no
 * `window`. Same channel, same refusal text.
 */
async function call<M extends MethodName>(method: M, payload: MethodInput<M>): Promise<MethodOutput<M>> {
  const bridge = (
    globalThis as unknown as {
      squad?: { invoke(method: string, payload: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> };
    }
  ).squad;
  if (bridge === undefined) throw new Error("界面和主进程之间的桥（window.squad）不存在：preload 没有加载成功。");
  const reply = await bridge.invoke(method, payload);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value as MethodOutput<M>;
}

const toBytes = (base64: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
};

const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let raw = "";
  // In slices: String.fromCharCode over a whole recording overflows the call stack.
  for (let at = 0; at < bytes.length; at += 0x8000) raw += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(raw);
};

export const api = {
  /** One chunk, read on the connection and at the speed chosen in settings. */
  speak: async (input: { readonly text: string; readonly voiceId: string }): Promise<Blob> => {
    const { audio, mimeType } = await call("voice.speak", input);
    return new Blob([toBytes(audio)], { type: mimeType });
  },
  /** One recording into text, on the connection and model chosen in settings. */
  transcribe: async (recording: Blob): Promise<string> => {
    const { text } = await call("voice.transcribe", {
      audio: await toBase64(recording),
      mimeType: recording.type === "" ? "audio/webm" : recording.type,
    });
    return text;
  },
};
