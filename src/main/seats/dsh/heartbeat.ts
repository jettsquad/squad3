/**
 * heartbeat.ts — the plugin that runs INSIDE a dsh seat and says it is alive.
 *
 * 移植自 Squad 2.x packages/seat-dsh/src/heartbeat.ts @ 8dcb903
 * 改动：2.x 让 dsh 子进程按绝对路径加载这个 .ts 源文件。打包后的 Squad 3 里没有源文件，
 * 所以这里把同一份插件写成一段纯 JS 文本，启动 dsh 席位前写到数据目录里（内容不变就不重写），
 * 再把那个路径交给补丁。插件本身逐行照搬，没有改逻辑。
 *
 * WHY it exists: the watchdog decides a seat is gone by watching its output
 * stop, and `dsh --profile headless` writes nothing at all until the turn is
 * over. This makes the silence mean what the watchdog thinks it means.
 *
 * The signal is WORK, never a clock: every line is caused by a session event.
 * A timer would keep a wedged child alive indefinitely.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The child's own copy of the prefixes, as literals: the module runs in
 * ANOTHER process and must not import ours. `dsh-heartbeat.test.ts` asserts
 * they match `SEAT_ALIVE_PREFIX` / `SEAT_USAGE_PREFIX`.
 */
export const HEARTBEAT_SOURCE = `// Squad 3 · dsh seat heartbeat (generated; see src/main/seats/dsh/heartbeat.ts)
export const name = "squad-seat-heartbeat";

const PREFIX = "[squad-alive]";
const USAGE_PREFIX = "[squad-usage]";

// One line a second at most: stderr is collected with a cap that keeps the
// TAIL, and an unthrottled heartbeat would evict the failure message.
const MIN_GAP_MS = 1000;

const ALWAYS = new Set([
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "tool/call",
  "tool/result",
  "llm/retry",
  "compaction/start",
]);

export function apply(ctx) {
  let lastAt = 0;
  // RUNNING TOTALS, re-printed whole: the parent reads only the tail of a
  // capped buffer, so the last line must be the whole answer.
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const write = (type) => {
    const now = Date.now();
    if (now - lastAt < MIN_GAP_MS && !ALWAYS.has(type)) return;
    lastAt = now;
    process.stderr.write(\`\${PREFIX} \${new Date(now).toISOString()} \${type}\\n\`);
  };
  write("mounted");
  ctx.on(
    "session/event",
    (...args) => {
      const event = args[1];
      const type = typeof event === "object" && event !== null && "type" in event ? String(event.type) : "?";
      write(type);
      addUsage(event, total);
    },
    { global: true },
  );
}

const numberAt = (source, key) => {
  if (typeof source !== "object" || source === null || !(key in source)) return 0;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

// The headless app discards the harness's usage chunks; this re-reports them.
function addUsage(event, total) {
  if (typeof event !== "object" || event === null) return;
  const data = event.data;
  const chunk = typeof data === "object" && data !== null ? data.chunk : undefined;
  if (typeof chunk !== "object" || chunk === null) return;
  if (chunk.type !== "usage") return;
  const usage = chunk.usage;
  if (typeof usage !== "object" || usage === null) return;
  total.inputTokens += numberAt(usage, "inputTokens");
  total.outputTokens += numberAt(usage, "outputTokens");
  total.cacheReadTokens += numberAt(usage, "cacheReadTokens");
  total.cacheCreationTokens += numberAt(usage, "cacheWriteTokens");
  process.stderr.write(\`\${USAGE_PREFIX} \${JSON.stringify(total)}\\n\`);
}
`;

/** Write the heartbeat module under `dir` (unchanged files are left alone) and return its absolute path. */
export function ensureHeartbeatModule(dir: string): string {
  const path = join(dir, "squad-seat-heartbeat.mjs");
  if (!existsSync(path) || readFileSync(path, "utf8") !== HEARTBEAT_SOURCE) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, HEARTBEAT_SOURCE, "utf8");
  }
  return path;
}
