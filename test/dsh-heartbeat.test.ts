// 移植自 Squad 2.x packages/seat-dsh/test/heartbeat.test.ts @ 8dcb903
// 改动：心跳插件在 3 里是内置的一段源码字符串（见 heartbeat.ts），所以从那段字符串里读字面量，而不是读文件。
/**
 * The heartbeat is written by one process and read by another, and the two
 * agree on a string literal rather than on an import — see `heartbeat.ts` for
 * why. This is the check that makes the copy safe.
 */
import {
  SEAT_ALIVE_PREFIX,
  SEAT_USAGE_PREFIX,
  usageFromStderr,
  withoutHeartbeats,
} from "../src/main/seat-runtime/index.ts";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_SOURCE } from "../src/main/seats/dsh/heartbeat.ts";
import { heartbeatRows } from "../src/main/seats/dsh/patch.ts";

describe("心跳前缀", () => {
  it("子进程写的前缀和父进程过滤的前缀是同一个", () => {
    // Read as TEXT on purpose: importing `heartbeat.ts` would run its module
    // body in the test process, and what needs checking is the literal in the
    // file the CHILD loads.
    const source = HEARTBEAT_SOURCE;
    const declared = /const PREFIX = "([^"]+)"/.exec(source)?.[1];
    expect(declared).toBe(SEAT_ALIVE_PREFIX);
  });

  it("心跳行不会被当成失败原因", () => {
    // The failure channel and the liveness channel share stderr. If this ever
    // stops holding, a seat's real error is buried under its own heartbeat.
    const stderr = [
      `${SEAT_ALIVE_PREFIX} 2026-08-28T00:00:00.000Z turn/start`,
      "dsh: MISSING_CREDENTIAL: llm-deepseek: no API key",
      `${SEAT_ALIVE_PREFIX} 2026-08-28T00:00:01.000Z assistant/chunk`,
    ].join("\n");
    expect(withoutHeartbeats(stderr).trim()).toBe("dsh: MISSING_CREDENTIAL: llm-deepseek: no API key");
  });
});

describe("heartbeatRows", () => {
  it("按绝对路径插入插件行", () => {
    // A bare package name would resolve from the CHILD's profile directory,
    // where nothing of ours is installed.
    expect(heartbeatRows("/abs/heartbeat.ts").join("\n")).toBe(
      ["- insert:", "    - id: squad-seat-heartbeat", '      name: "/abs/heartbeat.ts"'].join("\n"),
    );
  });
});

describe("dsh 的用量上报", () => {
  it("子进程写的用量前缀和父进程读的是同一个", () => {
    // 和心跳同样的理由：两份字面量分处两个进程，只能靠这条守住。
    const source = HEARTBEAT_SOURCE;
    const declared = /const USAGE_PREFIX = "([^"]+)"/.exec(source)?.[1];
    expect(declared).toBe(SEAT_USAGE_PREFIX);
  });

  it("取最后一行——每行都是累计值", () => {
    // 一轮里有几次模型调用就有几行，每行都是到目前为止的总数。取最后一行，
    // 意味着 stderr 被截断也不会少算。
    const stderr = [
      `${SEAT_USAGE_PREFIX} {"inputTokens":100,"outputTokens":10,"cacheReadTokens":0,"cacheCreationTokens":0}`,
      `${SEAT_ALIVE_PREFIX} 2026-09-10T00:00:00.000Z tool/call`,
      `${SEAT_USAGE_PREFIX} {"inputTokens":350,"outputTokens":42,"cacheReadTokens":80,"cacheCreationTokens":5}`,
    ].join("\n");
    expect(usageFromStderr(stderr)).toEqual({
      inputTokens: 350,
      outputTokens: 42,
      cacheReadTokens: 80,
      cacheCreationTokens: 5,
    });
  });

  it("用量行也不会被当成失败原因", () => {
    const stderr = [`${SEAT_USAGE_PREFIX} {"inputTokens":1}`, "dsh: MISSING_CREDENTIAL: llm-deepseek: no API key"].join(
      "\n",
    );
    expect(withoutHeartbeats(stderr).trim()).toBe("dsh: MISSING_CREDENTIAL: llm-deepseek: no API key");
  });

  it("没有用量行就是没有，不是零", () => {
    // 零会被读成「这一轮不花钱」——正是原来那个漏算之所以没人发现的原因。
    expect(usageFromStderr("dsh: 什么都没说")).toBeUndefined();
  });

  it("半截的 JSON 不会让这一轮失败", () => {
    // 进程被杀会留下写了一半的行。丢掉计数是对的代价，丢掉这一轮不是。
    expect(usageFromStderr(`${SEAT_USAGE_PREFIX} {"inputTokens":3`)).toBeUndefined();
  });
});
