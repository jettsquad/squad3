/**
 * backend-tools.ts — the CLIs seats run on: which version is installed, which
 * is newest, and how this machine would upgrade one.
 *
 * 移植自 Squad 2.x packages/console/src/backend-tools.ts @ 8e96d9c
 * 改动：
 * - 找命令走席位适配器自己的 `locate`（和开跑时一模一样，dsh 读设置里的路径）；Windows 上
 *   npm 装的是 `.cmd` 包装，看安装方式要看包装背后的真实文件。跑命令走 seat-runtime 的
 *   startChild（不经 shell，取消时清整棵进程树）——`execFile` 在 Windows 上跑不了 `.cmd`。
 * - npm 前缀认 Windows 的布局（`<prefix>\node_modules`，没有 `lib`）。
 * - dsh 在 3 里只是一个席位后端，不是 Squad 的底座；仍不一键升级，但理由照实说：它是一份
 *   源码目录，升级是拉代码再构建，不替人做。
 *
 * Here because a seat's failure is very often not the seat's: 「The
 * 'gpt-6-sol' model is not supported」 was a Codex CLI nine releases old, and
 * nothing on any screen said so.
 *
 * The decisions are pure and tested; the functions at the bottom do the
 * running. Nothing here takes a command from a request — the only input a
 * caller supplies is WHICH tool, and every argv is built from a closed table.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startChild, type ResolvedCommand } from "../seat-runtime/index.ts";

export type BackendTool = "claude-code" | "codex" | "dsh";

/**
 * How a tool got onto this machine — which decides how it is upgraded.
 * Detected, never assumed.
 */
export type InstallMethod = "npm-global" | "native" | "git-checkout" | "unknown";

export interface ToolStatus {
  readonly tool: BackendTool;
  /** The executable's name, as a person would type it. */
  readonly command: string;
  /** Absent when the tool is not installed, or would not say. */
  readonly installed?: string | undefined;
  /** Absent when the registry could not be reached. */
  readonly latest?: string | undefined;
  readonly outdated: boolean;
  readonly method: InstallMethod;
  /** The upgrade as a command line, for showing — and for doing by hand. */
  readonly upgradeCommand?: string | undefined;
  /** Whether the button may run that command itself. */
  readonly canUpgrade: boolean;
  /** Why something above is missing, in a sentence a person can act on. */
  readonly problem?: string | undefined;
}

export interface UpgradeReport {
  readonly tool: BackendTool;
  readonly ok: boolean;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
  /** What the commands printed, newest last. Shown when it did not work. */
  readonly log: string;
}

/** What each tool is called on the command line, and where its releases are announced. */
const TOOLS: Readonly<Record<BackendTool, { readonly command: string; readonly npmPackage?: string }>> = {
  "claude-code": { command: "claude", npmPackage: "@anthropic-ai/claude-code" },
  codex: { command: "codex", npmPackage: "@openai/codex" },
  dsh: { command: "dsh" },
};

export const BACKEND_TOOLS: readonly BackendTool[] = ["claude-code", "codex", "dsh"];

/**
 * The version inside whatever a `--version` printed.
 *
 * Each CLI words it differently — `codex-cli 0.162.0`, `2.1.294 (Claude
 * Code)`, a bare `0.1.2-alpha.5` — so the first thing shaped like a version
 * is taken rather than a format being expected.
 */
export function parseVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)?.[0];
}

/**
 * Order two versions: negative when `a` is older.
 *
 * Semver's rule for pre-releases, because all three tools ship them: a
 * release outranks its own pre-releases, and pre-release identifiers compare
 * field by field, numerically where both are numbers.
 */
export function compareVersions(a: string, b: string): number {
  const split = (version: string): { core: number[]; pre: string[] } => {
    const [core = "", ...rest] = version.split("-");
    const pre = rest.join("-");
    return {
      core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      pre: pre === "" ? [] : pre.split("."),
    };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const bothNumbers = /^\d+$/.test(l) && /^\d+$/.test(r);
    const difference = bothNumbers ? Number(l) - Number(r) : l < r ? -1 : l > r ? 1 : 0;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * How this tool was installed, read off where its program really lives.
 *
 * The RESOLVED path, because the name on PATH says nothing: a symlink on
 * macOS, an npm `.cmd` wrapper on Windows. An npm global sits under
 * `node_modules/<package>`, Claude Code's own installer keeps versions under
 * `.local/share/claude`, and dsh is a source checkout launched from `apps/cli`.
 */
export function installMethodOf(tool: BackendTool, resolvedPath: string): InstallMethod {
  const path = resolvedPath.replace(/\\/g, "/");
  const npmPackage = TOOLS[tool].npmPackage;
  if (npmPackage !== undefined && path.includes(`/node_modules/${npmPackage}/`)) return "npm-global";
  if (tool === "claude-code" && path.includes("/.local/share/claude/versions/")) return "native";
  if (tool === "dsh" && path.includes("/apps/cli/")) return "git-checkout";
  return "unknown";
}

/**
 * The npm prefix an npm-global install lives under, from its resolved path.
 *
 * So the upgrade goes back into the SAME tree. A machine can have several
 * npms (Homebrew's, nvm's, conda's), and upgrading through whichever one is
 * first on PATH installs a second copy that the `codex` on PATH never runs.
 * POSIX keeps globals in `<prefix>/lib/node_modules`; Windows in
 * `<prefix>\node_modules`.
 */
export function npmPrefixOf(resolvedPath: string): string | undefined {
  const path = resolvedPath.replace(/\\/g, "/");
  const posix = path.indexOf("/lib/node_modules/");
  if (posix >= 0) return path.slice(0, posix);
  const windows = /^[A-Za-z]:\//.test(path) ? path.indexOf("/node_modules/") : -1;
  return windows < 0 ? undefined : path.slice(0, windows);
}

/**
 * The upgrade for one tool, as argv.
 *
 * Nothing for dsh: in 3 it is a seat backend run from a source checkout, and
 * upgrading it means pulling and rebuilding that checkout — work done on
 * somebody's source tree that is theirs to do. Nothing for an install nobody
 * recognised, either: a guess here would be a command run against somebody's
 * machine on a hunch.
 */
export function upgradeArgv(
  tool: BackendTool,
  method: InstallMethod,
): { readonly command: string; readonly args: readonly string[] } | undefined {
  const npmPackage = TOOLS[tool].npmPackage;
  if (method === "npm-global" && npmPackage !== undefined) {
    return { command: "npm", args: ["install", "-g", `${npmPackage}@latest`] };
  }
  if (tool === "claude-code" && method === "native") return { command: "claude", args: ["update"] };
  return undefined;
}

/** The newest `dsh-v…` tag in `git ls-remote --tags` output. */
export function newestDshTag(lsRemote: string): string | undefined {
  const versions = [...lsRemote.matchAll(/refs\/tags\/dsh-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\^\{\})?$/gm)].map(
    (match) => match[1] as string,
  );
  return versions.sort(compareVersions).at(-1);
}

/** Put a status together from what was found. Pure, so the wording is tested. */
export function describeTool(found: {
  readonly tool: BackendTool;
  readonly resolvedPath?: string | undefined;
  readonly installed?: string | undefined;
  readonly latest?: string | undefined;
}): ToolStatus {
  const { tool, resolvedPath, installed, latest } = found;
  const command = TOOLS[tool].command;
  if (resolvedPath === undefined) {
    return { tool, command, outdated: false, method: "unknown", canUpgrade: false, problem: `没有找到 ${command}。` };
  }
  const method = installMethodOf(tool, resolvedPath);
  const plan = upgradeArgv(tool, method);
  const outdated = installed !== undefined && latest !== undefined && compareVersions(installed, latest) < 0;
  const problem =
    installed === undefined
      ? `${command} --version 没有返回版本号，它可能装坏了。`
      : latest === undefined
        ? "查不到最新版本（网络不通或源不可达）。"
        : tool === "dsh" && outdated
          ? "dsh 是一份源码目录，升级是在那里拉新代码再构建——Squad 不替你改源码目录，请在那边升级。"
          : outdated && plan === undefined
            ? `认不出 ${command} 是怎么安装的，请按你当初的安装方式手动升级。`
            : undefined;
  return {
    tool,
    command,
    ...(installed === undefined ? {} : { installed }),
    ...(latest === undefined ? {} : { latest }),
    outdated,
    method,
    ...(plan === undefined ? {} : { upgradeCommand: [plan.command, ...plan.args].join(" ") }),
    // A broken install may be repaired by the same command, so the button is
    // offered for one that will not report a version as well as an old one.
    canUpgrade: plan !== undefined && (outdated || installed === undefined),
    ...(problem === undefined ? {} : { problem }),
  };
}

/** The file a resolved command really runs: the script under Node, or the program itself. */
export function programOf(command: ResolvedCommand): string {
  const script = command.prefixArgs.findLast((arg) => /\.(js|cjs|mjs)$/i.test(arg));
  return script ?? command.file;
}

// ── Running things ─────────────────────────────────────────────────────────

interface Ran {
  readonly ok: boolean;
  readonly output: string;
}

/** Run one command to the end, no shell, the whole tree stopped on timeout. */
async function run(command: ResolvedCommand, args: readonly string[], timeoutMs: number, cwd = tmpdir()): Promise<Ran> {
  const child = startChild({
    command,
    args,
    cwd,
    env: { ...process.env, ...command.env },
    stdin: "",
    maxStdout: 8 * 1024 * 1024,
    maxStderr: 1024 * 1024,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.terminate();
  }, timeoutMs);
  try {
    const exit = await child.done;
    const output = `${child.stdout.value}${child.stderr.value}`.trim();
    if (exit.spawnError !== undefined) return { ok: false, output: `${exit.spawnError}\n${output}`.trim() };
    if (timedOut)
      return { ok: false, output: `${output}\n（${Math.round(timeoutMs / 1000)} 秒没结束，已中止）`.trim() };
    return { ok: exit.exitCode === 0, output };
  } finally {
    clearTimeout(timer);
  }
}

export interface ToolHost {
  /** The command a seat of this backend would run, or a sentence why there is none. */
  readonly locate: (tool: BackendTool) => ResolvedCommand;
  /** Any other program by name (`npm`, `git`), resolved the same way. */
  readonly resolve: (name: string) => ResolvedCommand;
  /** The registry; injectable for tests. */
  readonly fetch?: typeof fetch;
}

export interface BackendTools {
  inspect(tool: BackendTool): Promise<ToolStatus>;
  upgrade(tool: BackendTool): Promise<UpgradeReport>;
}

export function createBackendTools(host: ToolHost): BackendTools {
  const fetcher = host.fetch ?? fetch;
  const locate = (tool: BackendTool): ResolvedCommand | undefined => {
    try {
      return host.locate(tool);
    } catch {
      return undefined;
    }
  };
  const resolvedPathOf = async (command: ResolvedCommand): Promise<string | undefined> => {
    try {
      return await realpath(programOf(command));
    } catch {
      return undefined;
    }
  };
  const installedVersion = async (command: ResolvedCommand): Promise<{ version?: string; output: string }> => {
    const ran = await run(command, ["--version"], 20_000);
    const version = ran.ok ? parseVersion(ran.output) : undefined;
    return { ...(version === undefined ? {} : { version }), output: ran.output };
  };
  const latestVersion = async (tool: BackendTool, resolvedPath: string | undefined): Promise<string | undefined> => {
    const npmPackage = TOOLS[tool].npmPackage;
    try {
      if (npmPackage !== undefined) {
        const response = await fetcher(`https://registry.npmjs.org/${npmPackage}/latest`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return undefined;
        const body = (await response.json()) as { version?: unknown };
        return typeof body.version === "string" ? body.version : undefined;
      }
      if (resolvedPath === undefined) return undefined;
      // dsh is a checkout; its own remote is where its releases are tagged.
      const tags = await run(host.resolve("git"), ["ls-remote", "--tags", "origin"], 20_000, dirname(resolvedPath));
      return tags.ok ? newestDshTag(tags.output) : undefined;
    } catch {
      return undefined;
    }
  };

  /** One upgrade at a time: two npm installs into one tree corrupt it. */
  let upgrading = false;

  return {
    inspect: async (tool) => {
      const command = locate(tool);
      const resolvedPath = command === undefined ? undefined : await resolvedPathOf(command);
      const [installed, latest] = await Promise.all([
        command === undefined || resolvedPath === undefined
          ? Promise.resolve<{ version?: string; output: string }>({ output: "" })
          : installedVersion(command),
        latestVersion(tool, resolvedPath),
      ]);
      return describeTool({ tool, resolvedPath, installed: installed.version, latest });
    },

    /**
     * Upgrade one tool, then prove it still runs.
     *
     * `--version` afterwards is the test, not the installer's exit code. npm
     * reported success on a Codex upgrade that left the CLI unable to start:
     * its platform binary is an OPTIONAL dependency, the copy in npm's cache
     * was damaged, and a failed optional dependency is skipped in silence. So
     * when an npm upgrade leaves a tool that will not run, it is done once more
     * against an empty cache — which is what repaired it by hand.
     */
    upgrade: async (tool) => {
      if (upgrading) throw new Error("已经有一个升级在进行，等它结束。");
      upgrading = true;
      const log: string[] = [];
      try {
        const name = TOOLS[tool].command;
        const command = locate(tool);
        const resolvedPath = command === undefined ? undefined : await resolvedPathOf(command);
        if (command === undefined || resolvedPath === undefined) throw new Error(`没有找到 ${name}。`);
        const method = installMethodOf(tool, resolvedPath);
        const plan = upgradeArgv(tool, method);
        if (plan === undefined) {
          throw new Error(
            tool === "dsh"
              ? "dsh 不在这里升级：它是一份源码目录，请在那里拉新代码、重新构建。"
              : `认不出 ${name} 是怎么安装的，没法替你升级。`,
          );
        }
        const before = (await installedVersion(command)).version;

        // The npm that owns this install, not whichever is first on PATH.
        const prefix = method === "npm-global" ? npmPrefixOf(resolvedPath) : undefined;
        const ownNpm =
          prefix === undefined
            ? undefined
            : [join(prefix, "bin", "npm"), join(prefix, "npm.cmd")].find((candidate) => existsSync(candidate));
        const program =
          plan.command === "npm"
            ? host.resolve(ownNpm ?? "npm")
            : plan.command === "claude"
              ? command
              : host.resolve(plan.command);

        const attempt = async (extra: readonly string[]): Promise<string | undefined> => {
          const ran = await run(program, [...plan.args, ...extra], 10 * 60_000);
          log.push(`$ ${[plan.command, ...plan.args, ...extra].join(" ")}`, ran.output);
          const after = await installedVersion(command);
          if (after.version === undefined) log.push(`$ ${name} --version`, after.output);
          return after.version;
        };

        let after = await attempt([]);
        if (after === undefined && method === "npm-global") {
          const cache = await mkdtemp(join(tmpdir(), "squad-npm-cache-"));
          try {
            log.push("升级后运行不起来，换一个空缓存重装一次。");
            after = await attempt(["--cache", cache]);
          } finally {
            await rm(cache, { recursive: true, force: true }).catch(() => undefined);
          }
        }
        return {
          tool,
          ok: after !== undefined,
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after }),
          log: log.filter((line) => line !== "").join("\n"),
        };
      } finally {
        upgrading = false;
      }
    },
  };
}
