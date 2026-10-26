/**
 * Read-aloud and dictation on the main process: the key goes in a header,
 * never anywhere else; a provider's refusal comes back in its own words.
 */
import { describe, expect, it } from "vitest";
import { speak, speechEndpointFor, transcribe, transcriptionEndpointFor } from "../src/main/extras/index.ts";

const connection = { displayName: "语音", endpoint: "https://api.example.test/anthropic", credential: "test-key" };

/** A fetch that records what it was asked and answers with `reply`. */
function fake(reply: () => Response) {
  const asked: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { asked, fetcher };
}

describe("speechEndpointFor", () => {
  it("keeps the host and puts speech beside the chat API", () => {
    expect(speechEndpointFor("https://api.minimaxi.com/anthropic")).toBe("https://api.minimaxi.com/v1/t2a_v2");
    expect(speechEndpointFor("https://api.minimaxi.com/v1/")).toBe("https://api.minimaxi.com/v1/t2a_v2");
    expect(() => speechEndpointFor(" ")).toThrow(/没有填服务地址/);
  });
});

describe("speak", () => {
  it("sends the key as a bearer header and decodes the hex audio", async () => {
    const { asked, fetcher } = fake(() => Response.json({ data: { audio: "494433" }, base_resp: { status_code: 0 } }));
    const audio = await speak(connection, { text: "你好", voiceId: "v", speed: 9, languageBoost: "Chinese" }, fetcher);
    expect([...audio]).toEqual([0x49, 0x44, 0x33]);
    const headers = asked[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(String(asked[0]?.init.body)) as {
      voice_setting: { speed: number };
      language_boost: string;
    };
    // Clamped, not sent: outside 0.5–2 MiniMax refuses the whole request.
    expect(body.voice_setting.speed).toBe(2);
    expect(body.language_boost).toBe("Chinese");
    expect(asked[0]?.url).not.toContain("test-key");
  });

  it("says MiniMax's own refusal, and refuses a connection with no key before calling anyone", async () => {
    const { fetcher } = fake(() =>
      Response.json({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } }),
    );
    await expect(speak(connection, { text: "x", voiceId: "v", languageBoost: "Chinese" }, fetcher)).rejects.toThrow(
      /insufficient balance/,
    );
    const none = fake(() => Response.json({}));
    await expect(
      speak(
        { ...connection, credential: undefined },
        { text: "x", voiceId: "v", languageBoost: "Chinese" },
        none.fetcher,
      ),
    ).rejects.toThrow(/没有可用的密钥/);
    expect(none.asked).toHaveLength(0);
  });
});

describe("transcriptionEndpointFor", () => {
  it("is OpenAI's path, and refuses an Anthropic-shaped address by name", () => {
    expect(transcriptionEndpointFor("https://api.siliconflow.cn/v1")).toBe(
      "https://api.siliconflow.cn/v1/audio/transcriptions",
    );
    expect(transcriptionEndpointFor("http://127.0.0.1:9/")).toBe("http://127.0.0.1:9/v1/audio/transcriptions");
    expect(() => transcriptionEndpointFor("https://api.minimaxi.com/anthropic")).toThrow(/OpenAI 兼容/);
  });
});

describe("transcribe", () => {
  const audio = new Uint8Array([1, 2, 3]);
  const openai = { ...connection, endpoint: "https://api.example.test/v1" };

  it("posts the recording as a file with the chosen model, and returns the text", async () => {
    const { asked, fetcher } = fake(() => Response.json({ text: " 你好世界 " }));
    const text = await transcribe(openai, { audio, mimeType: "audio/webm;codecs=opus", model: "whisper-1" }, fetcher);
    expect(text).toBe("你好世界");
    const form = asked[0]?.init.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect((form.get("file") as File).name).toBe("speech.webm");
    expect((asked[0]?.init.headers as Record<string, string>)["authorization"]).toBe("Bearer test-key");
  });

  it("says the provider's own refusal", async () => {
    const { fetcher } = fake(() =>
      Response.json({ error: { message: "model not found: whisper-9" } }, { status: 400 }),
    );
    await expect(transcribe(openai, { audio, mimeType: "audio/webm", model: "whisper-9" }, fetcher)).rejects.toThrow(
      /HTTP 400：model not found: whisper-9/,
    );
  });

  it("refuses before calling anyone when there is no model, no key, or no sound", async () => {
    const { asked, fetcher } = fake(() => Response.json({ text: "x" }));
    await expect(transcribe(openai, { audio, mimeType: "audio/webm", model: " " }, fetcher)).rejects.toThrow(/模型名/);
    await expect(
      transcribe({ ...openai, credential: undefined }, { audio, mimeType: "audio/webm", model: "m" }, fetcher),
    ).rejects.toThrow(/密钥/);
    await expect(
      transcribe(openai, { audio: new Uint8Array(), mimeType: "audio/webm", model: "m" }, fetcher),
    ).rejects.toThrow(/没有录到声音/);
    expect(asked).toHaveLength(0);
  });
});
