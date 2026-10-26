/**
 * The child process for one seat turn, run for real (Node as the child).
 *
 * The tree-kill test is the one that matters most: a CLI agent runs tools,
 * and a tool runs processes. Stopping only the CLI leaves its build or test
 * run going in the project folder after the person pressed 叫停.
 */
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { startChild, TailBuffer } from "../src/main/seat-runtime/process.ts";
import { runCliSeat } from "../src/main/seat-runtime/run.ts";

const node = { file: process.execPath, prefixArgs: [] as string[] };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

describe("TailBuffer", () => {
  it("keeps the tail, counts everything, and says it dropped the head", () => {
    const buffer = new TailBuffer(5);
    buffer.append("abc");
    buffer.append("defg");
    expect(buffer.value).toBe("cdefg");
    expect(buffer.received).toBe(7);
    expect(buffer.lossy).toBe(true);
  });
});

describe("startChild", () => {
  it("hands the prompt over stdin, intact, Chinese and quotes included", async () => {
    const prompt = '主持人说："用 Postgres 吗？" 100% 确定 & 没有 %PATH% 展开\n第二行';
    const child = startChild({
      command: node,
      args: [
        "-e",
        "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s))",
      ],
      cwd: tmpdir(),
      env: process.env,
      stdin: prompt,
    });
    const exit = await child.done;
    expect(exit.exitCode).toBe(0);
    expect(child.stdout.value).toBe(prompt);
  });

  it("collects stderr separately", async () => {
    const child = startChild({
      command: node,
      args: ["-e", "process.stderr.write('拒绝了'); process.exit(3)"],
      cwd: tmpdir(),
      env: process.env,
      stdin: "",
    });
    const exit = await child.done;
    expect(exit.exitCode).toBe(3);
    expect(child.stderr.value).toBe("拒绝了");
  });

  it("settles with the reason when the program cannot start at all", async () => {
    const child = startChild({
      command: { file: "Z:\\definitely\\not\\here.exe", prefixArgs: [] },
      args: [],
      cwd: tmpdir(),
      env: process.env,
      stdin: "",
    });
    const exit = await child.done;
    expect(exit.spawnError).toBeDefined();
  });

  it("terminate() kills the grandchild too", async () => {
    // The child starts a grandchild that would outlive it, prints its pid, and waits.
    const script = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(g.pid) + '\\n');
      setInterval(() => {}, 1000);
    `;
    const child = startChild({ command: node, args: ["-e", script], cwd: tmpdir(), env: process.env, stdin: "" });
    expect(await waitFor(() => /\d+\n/.test(child.stdout.value))).toBe(true);
    const grandchild = Number.parseInt(child.stdout.value, 10);
    expect(alive(grandchild)).toBe(true);
    child.terminate();
    await child.done;
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  }, 20_000);
});

describe("runCliSeat", () => {
  const limits = { idleMs: 60_000, firstOutputMs: 60_000, pollMs: 200 };

  it("never rejects: a missing folder is a failed seat that names the folder", async () => {
    const run = runCliSeat({
      who: "测试席位",
      command: node,
      args: [],
      stdin: "x",
      cwd: "Z:\\no\\such\\folder",
      env: process.env,
      parse: (stdout) => ({ text: stdout, failed: false }),
      limits,
    });
    const result = await run.result;
    expect(result.failed).toBe(true);
    expect(result.text).toContain("Z:\\no\\such\\folder");
  });

  it("explains a silent failure from stderr", async () => {
    const run = runCliSeat({
      who: "测试席位",
      command: node,
      args: ["-e", "process.stderr.write('MISSING_CREDENTIAL'); process.exit(1)"],
      stdin: "x",
      cwd: tmpdir(),
      env: process.env,
      parse: (stdout) => ({ text: stdout, failed: stdout === "" }),
      limits,
    });
    const result = await run.result;
    expect(result.failed).toBe(true);
    expect(result.text).toContain("MISSING_CREDENTIAL");
  });

  it("a cancelled seat hands back exactly what it had said, marked cancelled", async () => {
    // Marking it 「未答完」 is the table's job (it also writes who stopped it);
    // here the half-answer must arrive unaltered.
    const controller = new AbortController();
    const run = runCliSeat({
      who: "测试席位",
      command: node,
      args: ["-e", "process.stdout.write('我先读两份文档'); setInterval(()=>{}, 1000)"],
      stdin: "x",
      cwd: tmpdir(),
      env: process.env,
      parse: (stdout) => ({ text: stdout, failed: false }),
      limits,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 500);
    const result = await run.result;
    expect(result.cancelled).toBe(true);
    expect(result.failed).toBe(true);
    expect(result.text).toBe("我先读两份文档");
  }, 20_000);
});
