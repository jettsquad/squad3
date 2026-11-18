import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { killTree, TailBuffer, type ResolvedCommand } from "../../seat-runtime/index.ts";

export interface RpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** Bounded JSONL transport. No prompts or provider credentials on the command line. */
export class CloudRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly stderr = new TailBuffer(8192);
  private buffer = "";
  private id = 0;
  private closed = false;
  private readonly exited: Promise<void>;
  onMessage: (message: RpcMessage) => void = () => undefined;
  onClosed: (error: Error) => void = () => undefined;

  constructor(command: ResolvedCommand, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(command.file, [...command.prefixArgs, ...args], {
      cwd,
      env: { ...env, ...command.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.exited = new Promise((done) => {
      this.child.once("close", () => done());
      this.child.once("error", () => done());
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (s: string) => this.stderr.append(s));
    this.child.stdout.on("data", (s: string) => this.feed(s));
    this.child.on("error", (e) => this.fail(e));
    this.child.stdin.on("error", (e) => this.fail(e));
    this.child.on("close", (code, signal) =>
      this.fail(
        new Error(
          `运行时连接已关闭（${String(code)} / ${String(signal)}）。${this.stderr.value.replace(/Bearer\s+\S+|\bsk-[\w-]+/gi, "[已隐藏]")}`,
        ),
      ),
    );
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.fail(new Error("运行时消息超过 4 MiB 上限。"));
      this.close();
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (line.trim() === "") continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.fail(new Error("运行时返回了无效的 JSON 消息。"));
        this.close();
        return;
      }
      if (message === null || typeof message !== "object") {
        this.fail(new Error("运行时消息必须是对象。"));
        this.close();
        return;
      }
      if (message.method !== undefined) {
        try {
          this.onMessage(message);
        } catch (e) {
          this.fail(e instanceof Error ? e : new Error(String(e)));
        }
        continue;
      }
      if (typeof message.id !== "number") continue;
      const p = this.pending.get(message.id);
      if (p === undefined) continue;
      this.pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.error !== undefined) p.reject(new Error(message.error.message));
      else p.resolve(message.result);
    }
  }

  send(message: RpcMessage): void {
    if (this.closed) throw new Error("运行时连接已关闭。");
    const line = JSON.stringify(message);
    if (line.length > 2 * 1024 * 1024 || this.child.stdin.writableLength > 4 * 1024 * 1024)
      throw new Error("请求或发送队列超过上限。");
    this.child.stdin.write(line + "\n");
  }

  request<T>(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 等待超时；未自动重试。`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "squad3_cloud", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized", params: {} });
  }

  private fail(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    if (!this.closed) this.onClosed(error);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.fail(new Error("运行已结束。"));
      killTree(this.child);
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((done) => {
        timer = setTimeout(done, 5000);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }
}
