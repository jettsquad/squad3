// 移植自 Squad 2.x packages/console/test/speech-pause.test.ts @ 8e96d9c
// 改动：被替换的依赖从 client/api.ts 换成 3 的 renderer/src/speech-api.ts（合成调用住在那里）；
// 只替换 URL 的两个 blob 方法而不是整个 URL——这一版 vitest 加载模块时要用到 URL。
/**
 * The pause/resume state machine.
 *
 * Written because the interesting cases are the ones nobody hits by clicking
 * once: pausing in the gap between chunks, where there is no element to
 * pause, and resuming after a chunk has ended, where the element still held
 * would replay what was just heard.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** One fake `Audio`, recording what was asked of it. */
class FakeAudio {
  static made: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  plays = 0;
  pauses = 0;
  constructor() {
    FakeAudio.made.push(this);
  }
  play(): Promise<void> {
    this.plays += 1;
    return Promise.resolve();
  }
  pause(): void {
    this.pauses += 1;
  }
  /** What a real element does when the chunk finishes. */
  end(): void {
    this.onended?.();
  }
}

/** Resolves once every already-queued microtask has run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

let releaseSpeak: ((blob: Blob) => void) | undefined;
const speakCalls = { n: 0 };

vi.mock("../src/renderer/src/speech-api.ts", () => ({
  api: {
    speak: () => {
      speakCalls.n += 1;
      return new Promise<Blob>((resolve) => {
        releaseSpeak = resolve;
      });
    },
  },
}));

const g = globalThis as unknown as Record<string, unknown>;
g.Audio = FakeAudio;
Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined });
g.localStorage = {
  getItem: (k: string) => (k === "squad.listen.connection" ? "conn-1" : "1"),
};

const { speech } = await import("../src/renderer/src/speech.ts");

// 切片按 600 字一段（SPEECH_CHUNK_CHARS），所以要真的够长才会有第二段——
// 「分片之间」那几条边界只在多段时才存在。
const long = "这是一句用来凑长度的话。".repeat(60);
const item = { turnId: "t1", speaker: "甲", text: `${long}${long}`, voiceId: "v" };

describe("暂停与继续", () => {
  beforeEach(() => {
    speech.stop();
    FakeAudio.made = [];
    speakCalls.n = 0;
    releaseSpeak = undefined;
  });

  it("暂停留住位置，stop 才丢掉", async () => {
    void speech.play(item);
    await settle();
    releaseSpeak?.(new Blob([]));
    await settle();

    const first = FakeAudio.made[0];
    expect(first?.plays).toBe(1);

    speech.pause();
    expect(speech.state().paused).toBe(true);
    // 还在这一条上——这正是它跟 stop 的区别。
    expect(speech.state().turnId).toBe("t1");
    expect(first?.pauses).toBe(1);

    speech.resume();
    expect(speech.state().paused).toBe(false);
    expect(first?.plays).toBe(2);

    speech.stop();
    expect(speech.state().turnId).toBeUndefined();
    expect(speech.state().paused).toBe(false);
  });

  it("分片之间暂停：新分片不会自己开口", async () => {
    void speech.play(item);
    await settle();
    releaseSpeak?.(new Blob([]));
    await settle();

    // 第一段放完，进入第二段的合成——这段窗口里没有元素可暂停。
    FakeAudio.made[0]?.end();
    await settle();
    speech.pause();

    releaseSpeak?.(new Blob([]));
    await settle();
    const second = FakeAudio.made[1];
    expect(second).toBeDefined();
    // 合成回来了，但按住了就不许响。
    expect(second?.plays).toBe(0);

    speech.resume();
    expect(second?.plays).toBe(1);
  });

  it("继续不会重播刚念完的那一段", async () => {
    void speech.play(item);
    await settle();
    releaseSpeak?.(new Blob([]));
    await settle();

    const first = FakeAudio.made[0];
    first?.end();
    await settle();

    // 这一段已经结束，播放器不该再攥着它——否则「继续」会把它重放一遍。
    speech.pause();
    speech.resume();
    expect(first?.plays).toBe(1);
  });

  it("没在念的时候，暂停和继续都不做事", () => {
    speech.pause();
    expect(speech.state().paused).toBe(false);
    speech.resume();
    expect(speech.state().paused).toBe(false);
    expect(speakCalls.n).toBe(0);
  });
});
