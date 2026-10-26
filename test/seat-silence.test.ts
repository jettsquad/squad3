// 移植自 Squad 2.x packages/seat-runtime/test/silence.test.ts @ 8dcb903
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEAT_SILENCE_LIMITS, silenceMessage, silenceVerdict, watchSilence } from "../src/main/seat-runtime/silence.ts";

const limits = { idleMs: 600_000, firstOutputMs: 90_000 };

describe("silenceVerdict", () => {
  it("一个字都没出来时，用短的那条线", () => {
    expect(silenceVerdict(0, 89_000, limits)).toBeUndefined();
    expect(silenceVerdict(0, 90_000, limits)).toBe("no-output");
  });

  it("已经出过东西的，用长的那条线", () => {
    expect(silenceVerdict(1, 90_000, limits)).toBeUndefined();
    expect(silenceVerdict(1, 600_000, limits)).toBe("silent");
  });

  it("两种判决分得开", () => {
    // 「从没答过」查端点，「答着停了」查这一轮——两个不同的地方。
    expect(silenceVerdict(0, 10 ** 9, limits)).toBe("no-output");
    expect(silenceVerdict(5, 10 ** 9, limits)).toBe("silent");
  });

  it("安静时长从最后一个字节算起", () => {
    expect(silenceVerdict(1000, 0, limits)).toBeUndefined();
  });
});

describe("silenceMessage", () => {
  it("两条消息把人送去不同的地方", () => {
    // 「一个字都没输出」多半是端点错了，「说到一半停了」是另一回事——
    // 两种情况人要去查的地方不一样，所以文案不能共用。
    expect(silenceMessage("no-output", limits)).toMatch(/连不上/);
    expect(silenceMessage("no-output", limits)).toMatch(/2 分钟/);
    expect(silenceMessage("silent", limits)).toMatch(/10 分钟/);
    expect(silenceMessage("silent", limits)).not.toMatch(/连不上/);
  });

  it("卡死那条要说清判据是静默，不是耗时", () => {
    // 不写这句，人会以为「跑得久就会被杀」，于是不敢派长任务。
    expect(silenceMessage("silent", limits)).toMatch(/有输出.*就重新计时/);
  });
});

describe("SEAT_SILENCE_LIMITS", () => {
  it("静默阈值就是 1.x 的十五分钟", () => {
    // 1.x 的四个执行器各写了一遍 900_000，恰好一致但没有任何东西保证它们一致。
    // 这里是唯一的一份，这条测试是把它钉住的那颗钉子。
    expect(SEAT_SILENCE_LIMITS.idleMs).toBe(900_000);
  });

  it("首字期限远短于静默期限", () => {
    // 一个字都没出来，多半是端点连不上；让人等十五分钟去证明一件连接测试
    // 一秒就能证明的事，是把耐心花在没有信息量的地方。
    expect(SEAT_SILENCE_LIMITS.firstOutputMs).toBeLessThan(SEAT_SILENCE_LIMITS.idleMs / 2);
  });

  it("首字期限要给冷启动留出成倍的余量", () => {
    // 实测：dsh 席位一轮的首字用了约 100 秒（profile 启动 + 首个 token）。
    // 期限压到那个数字附近，迟早会杀掉一个正在正常工作的席位——
    // 而一个乱叫的看门狗，会在它真正叫对的那天被忽略。
    expect(SEAT_SILENCE_LIMITS.firstOutputMs).toBeGreaterThanOrEqual(100_000 * 2.5);
  });
});

describe("watchSilence：有命令在跑的席位", () => {
  const fast = { idleMs: 10_000, firstOutputMs: 5_000, pollMs: 1_000 };
  afterEach(() => vi.useRealTimers());

  it("安静满一个窗口但有命令在跑：不中止，报一次，重新计时", async () => {
    // 就是那个跑全量测试的席位：十五分钟不出声，命令却一直在跑。
    vi.useFakeTimers();
    const verdicts: string[] = [];
    const quiets: number[] = [];
    watchSilence(
      async () => 100,
      fast,
      (reason) => verdicts.push(reason),
      {
        running: () => true,
        onQuiet: (quietFor) => quiets.push(quietFor),
      },
    );
    await vi.advanceTimersByTimeAsync(11_500);
    expect(verdicts).toEqual([]);
    expect(quiets).toHaveLength(1);
    expect(quiets[0]).toBeGreaterThanOrEqual(10_000);
    // 每满一个窗口报一次，而不是报过就再也不管。
    await vi.advanceTimersByTimeAsync(10_500);
    expect(quiets).toHaveLength(2);
    expect(verdicts).toEqual([]);
  });

  it("命令跑完之后还是不出声，照旧判卡死", async () => {
    vi.useFakeTimers();
    const verdicts: string[] = [];
    let running = true;
    watchSilence(
      async () => 100,
      fast,
      (reason) => verdicts.push(reason),
      {
        running: () => running,
        onQuiet: () => undefined,
      },
    );
    await vi.advanceTimersByTimeAsync(11_500);
    running = false;
    await vi.advanceTimersByTimeAsync(11_500);
    expect(verdicts).toEqual(["silent"]);
  });

  it("一个字都没出过的席位，不因为「有命令」被放过", async () => {
    // 没出过字节就不可能启动过命令；这条线管的是端点连不上。
    vi.useFakeTimers();
    const verdicts: string[] = [];
    watchSilence(
      async () => 0,
      fast,
      (reason) => verdicts.push(reason),
      {
        running: () => true,
        onQuiet: () => undefined,
      },
    );
    await vi.advanceTimersByTimeAsync(6_500);
    expect(verdicts).toEqual(["no-output"]);
  });

  it("不读输出流的后端，规则和以前一样", async () => {
    vi.useFakeTimers();
    const verdicts: string[] = [];
    watchSilence(
      async () => 100,
      fast,
      (reason) => verdicts.push(reason),
    );
    await vi.advanceTimersByTimeAsync(11_500);
    expect(verdicts).toEqual(["silent"]);
  });
});

describe("silenceMessage：命令在跑", () => {
  it("说清有命令没跑完时不会被中止", () => {
    expect(silenceMessage("silent", { idleMs: 900_000, firstOutputMs: 300_000 })).toMatch(/命令还没跑完.*不会被中止/);
  });
});
