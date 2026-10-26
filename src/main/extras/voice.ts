/**
 * voice.ts — one chunk of text into audio, and one recording into text.
 *
 * 朗读部分移植自 Squad 2.x packages/console/src/tts.ts @ 8e96d9c
 * 改动：连接与密钥由调用方解析好传进来（3 没有 dsh 的 ctx），`fetch` 可注入以便测试。
 * 听写部分是 3 新写的（设计文档 §15 Q3）：2.x 用浏览器的 Web Speech，它在 Electron 里
 * 没有 Google 语音服务的授权，用不了；改成连接库里一个 OpenAI 兼容的
 * `/audio/transcriptions` 服务，走现有的连接和凭据。
 *
 * On the main process and not in the window for one reason: the key. A
 * connection's credential is resolved per operation and must never reach a
 * page — so the window sends text or audio and receives bytes or text, and the
 * secret stays on this side of the wire.
 */

type Fetch = typeof fetch;

/** What it takes to reach a connection's service: its address and its key. */
export interface VoiceConnection {
  readonly displayName: string;
  readonly endpoint?: string | undefined;
  readonly credential: string | undefined;
}

/** What the main process needs to say one chunk. */
export interface SpeakRequest {
  readonly text: string;
  readonly voiceId: string;
  /** 0.5–2. Outside that MiniMax refuses, so it is clamped rather than sent. */
  readonly speed?: number | undefined;
  readonly model?: string | undefined;
  readonly languageBoost: "Chinese" | "English";
}

/** The default voice, used when a seat has not been given one. */
export const DEFAULT_VOICE = "Chinese (Mandarin)_Lyrical_Voice";

/**
 * Turbo rather than HD.
 *
 * A discussion is listened to as it arrives, so latency is the whole
 * experience; HD's extra quality buys nothing you notice while waiting for
 * the next seat to start talking.
 */
export const DEFAULT_TTS_MODEL = "speech-02-turbo";

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** The speech endpoint for a connection's base URL. */
export function speechEndpointFor(endpoint: string | undefined): string {
  const base = (endpoint ?? "").trim().replace(/\/+$/, "");
  // The connection points at the chat API — `/v1` for the OpenAI-compatible
  // shape, `/anthropic` for the Claude one. Speech lives beside them at
  // `/v1/t2a_v2`, so the host is what carries over, not the path.
  const host = base.replace(/\/(v1|anthropic)$/, "");
  if (host === "") throw new Error("这个连接没有填服务地址，合成不了语音。");
  return `${host}/v1/t2a_v2`;
}

/**
 * Synthesise one chunk. Throws with MiniMax's own words when it refuses.
 *
 * Its refusals are specific — an exhausted quota, a model the subscription
 * does not cover — and they are the entire value of the failure. A generic
 * 「合成失败」 would throw away the only part that says what to do.
 *
 * MiniMax's `t2a_v2`, with the audio inlined as hex rather than returned as a
 * URL. The URL form works and then does not: the object it points at lives in
 * a bucket whose ACL refuses anonymous reads. Hex costs one decode and
 * depends on nothing.
 */
export async function speak(
  connection: VoiceConnection,
  request: SpeakRequest,
  fetcher: Fetch = fetch,
): Promise<Buffer> {
  if (connection.credential === undefined) {
    throw new Error(`连接「${connection.displayName}」没有可用的密钥，合成不了语音。`);
  }
  const response = await fetcher(speechEndpointFor(connection.endpoint), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${connection.credential}` },
    body: JSON.stringify({
      model: request.model ?? DEFAULT_TTS_MODEL,
      text: request.text,
      voice_setting: { voice_id: request.voiceId, speed: clamp(request.speed ?? 1, 0.5, 2) },
      audio_setting: { format: "mp3" },
      // Named rather than left to auto-detect: with nothing sent, a Chinese
      // sentence with a formula in it was read in German.
      language_boost: request.languageBoost,
    }),
  });
  if (!response.ok) throw new Error(`语音接口回了 HTTP ${response.status}。`);

  const body = (await response.json()) as {
    data?: { audio?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  const status = body.base_resp?.status_code ?? 0;
  if (status !== 0) throw new Error(`语音接口拒绝了：${body.base_resp?.status_msg ?? `状态码 ${status}`}`);
  const hex = body.data?.audio;
  if (hex === undefined || hex === "") throw new Error("语音接口没有返回音频。");
  return Buffer.from(hex, "hex");
}

/**
 * The transcription endpoint for a connection's base URL.
 *
 * OpenAI's shape, which most providers that offer it copy: `<base>/v1/audio/
 * transcriptions`. A connection already ending in `/v1` keeps it; one
 * pointing at an Anthropic-shaped path is not a transcription service, and
 * saying so beats a 404 from a path that never existed.
 */
export function transcriptionEndpointFor(endpoint: string | undefined): string {
  const base = (endpoint ?? "").trim().replace(/\/+$/, "");
  if (base === "") throw new Error("这个连接没有填服务地址，听写不了。");
  if (/\/anthropic$/.test(base)) {
    throw new Error(
      "这个连接是 Anthropic 形状的地址，不提供语音转文字。听写要选一个 OpenAI 兼容的连接（地址以 /v1 结尾）。",
    );
  }
  return /\/v1$/.test(base) ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
}

export interface TranscribeRequest {
  readonly audio: Uint8Array;
  /** What the recorder produced, e.g. `audio/webm;codecs=opus`. Decides the file name sent. */
  readonly mimeType: string;
  /** The provider's model name — they differ (`whisper-1`, `FunAudioLLM/SenseVoiceSmall`, …). */
  readonly model: string;
  /** A hint, ISO-639-1. Optional: some providers refuse a language they detect on their own. */
  readonly language?: string | undefined;
}

const extensionOf = (mimeType: string): string => {
  const kind = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (kind.endsWith("/webm")) return "webm";
  if (kind.endsWith("/ogg")) return "ogg";
  if (kind.endsWith("/wav") || kind.endsWith("/x-wav")) return "wav";
  if (kind.endsWith("/mp4") || kind.endsWith("/m4a")) return "m4a";
  if (kind.endsWith("/mpeg")) return "mp3";
  return "webm";
};

/**
 * One recording into text. Throws with the provider's own words when it
 * refuses — a wrong model name is the common case, and only their sentence
 * says which name they wanted.
 */
export async function transcribe(
  connection: VoiceConnection,
  request: TranscribeRequest,
  fetcher: Fetch = fetch,
): Promise<string> {
  if (connection.credential === undefined) {
    throw new Error(`连接「${connection.displayName}」没有可用的密钥，听写不了。`);
  }
  if (request.model.trim() === "")
    throw new Error("还没有填听写用的模型名。到设置里填上（各家不一样，例如 whisper-1）。");
  if (request.audio.byteLength === 0) throw new Error("没有录到声音。");
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(request.audio)], { type: request.mimeType }),
    `speech.${extensionOf(request.mimeType)}`,
  );
  form.append("model", request.model.trim());
  form.append("response_format", "json");
  if (request.language !== undefined && request.language !== "") form.append("language", request.language);
  const response = await fetcher(transcriptionEndpointFor(connection.endpoint), {
    method: "POST",
    headers: { authorization: `Bearer ${connection.credential}` },
    body: form,
  });
  const raw = await response.text();
  let body: { text?: unknown; error?: { message?: unknown } | string; message?: unknown } = {};
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    // Not JSON: the status line and the start of what came back say more than a parse error.
  }
  if (!response.ok) {
    const said =
      typeof body.error === "string"
        ? body.error
        : typeof body.error?.message === "string"
          ? body.error.message
          : typeof body.message === "string"
            ? body.message
            : raw.slice(0, 200);
    throw new Error(`听写接口回了 HTTP ${response.status}：${said}`);
  }
  if (typeof body.text !== "string") throw new Error("听写接口没有返回文字。");
  return body.text.trim();
}
