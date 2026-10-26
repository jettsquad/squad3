/**
 * command.ts — turning a command name into something `spawn` can run without a shell.
 *
 * New in Squad 3. 2.x ran on macOS, where `claude` on PATH is the program.
 * On Windows, npm installs a `.cmd` wrapper instead, and there are two shapes
 * of it on this machine alone:
 *
 *   claude.cmd → "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
 *   codex.cmd  → "%_prog%" "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 *
 * `spawn` cannot run a `.cmd` without `shell: true`, and a shell means every
 * argument passes through cmd.exe's quoting — a seat prompt full of quotes,
 * percent signs and newlines is exactly what that mangles. So the wrapper is
 * read instead, and its real target is run directly: an `.exe` as itself, a
 * `.js` under Node.
 *
 * Kept free of `child_process` so it can be tested with a fake filesystem.
 */
import { delimiter, extname, isAbsolute, join, win32 } from "node:path";

/** What to spawn: the file, and arguments that go before the caller's own. */
export interface ResolvedCommand {
  readonly file: string;
  readonly prefixArgs: readonly string[];
  /** Extra environment the launch itself needs (e.g. running Node through Electron). */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface CommandHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  /** The running executable, for when no `node` is on PATH (Electron can act as Node). */
  readonly execPath: string;
}

export class CommandNotFoundError extends Error {
  readonly command: string;
  constructor(command: string, searched: readonly string[]) {
    super(
      `找不到命令「${command}」。查过 PATH 上的 ${searched.length} 个目录。` +
        `装好它并确认它在 PATH 上；或者在设置里写明它的完整路径。`,
    );
    this.command = command;
  }
}

function pathDirs(env: CommandHost["env"]): string[] {
  const raw = env["PATH"] ?? env["Path"] ?? "";
  return raw.split(delimiter).filter((dir) => dir.trim() !== "");
}

/** Find a file on PATH, honouring PATHEXT on Windows. */
export function findOnPath(name: string, host: CommandHost): string | undefined {
  if (isAbsolute(name)) return host.exists(name) ? name : undefined;
  const exts =
    host.platform === "win32"
      ? extname(name) !== ""
        ? [""]
        : (host.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())
      : [""];
  for (const dir of pathDirs(host.env)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (host.exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The real program behind an npm `.cmd` wrapper.
 *
 * npm's wrappers quote every target as `"%dp0%\<relative path>"`. The program
 * is the last such path ending in `.exe` or `.js` that is not the wrapper's
 * own optional `node.exe`.
 */
export function shimTarget(shimPath: string, text: string): string | undefined {
  const targets = [...text.matchAll(/"%dp0%\\([^"]+)"/gi)]
    .map((match) => match[1] ?? "")
    .filter((rel) => /\.(exe|js|cjs|mjs)$/i.test(rel) && !/^node\.exe$/i.test(rel));
  const rel = targets.at(-1);
  // win32 explicitly: a `.cmd` wrapper is a Windows file whatever runs this.
  return rel === undefined ? undefined : win32.join(win32.dirname(shimPath), rel);
}

/**
 * A hand-written wrapper: one line that runs a program by absolute path —
 * optionally with one script — and passes every argument on with `%*`.
 *
 *   @echo off
 *   "C:\Program Files\nodejs\node.exe" "H:\Programs\DSH\apps\cli\lib\bin.js" %*
 *
 * (how dsh is put on PATH when it runs from a checkout, 2026-10-23). Anything
 * more — variables, a second command, arguments of its own, no `%*` — is not
 * read: running something other than what the wrapper would run is worse
 * than saying it cannot be read.
 */
export function plainWrapperTarget(text: string): { readonly program: string; readonly script?: string } | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^@?echo\s+off$/i.test(line) && !/^(rem\b|::)/i.test(line))
    .filter((line) => !/^@?(setlocal|endlocal)\b/i.test(line));
  if (lines.length !== 1) return undefined;
  const line = (lines[0] ?? "").replace(/^@/, "");
  if (line.includes("%") && !/ %\*$/.test(line)) return undefined;
  const body = line.replace(/\s+%\*$/, "");
  if (body === line || body.includes("%")) return undefined;
  const parts = [...body.matchAll(/"([^"]+)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
  const [program, script, ...rest] = parts;
  if (program === undefined || rest.length > 0 || !win32.isAbsolute(program)) return undefined;
  if (!/\.(exe|com)$/i.test(program)) return undefined;
  if (script === undefined) return { program };
  if (!win32.isAbsolute(script) || !/\.(js|cjs|mjs)$/i.test(script)) return undefined;
  return { program, script };
}

/** How to run a `.js` entry point: a real `node` if there is one, else this executable as Node. */
function nodeFor(script: string, host: CommandHost): ResolvedCommand {
  const node = findOnPath(host.platform === "win32" ? "node.exe" : "node", host);
  if (node !== undefined) return { file: node, prefixArgs: [script] };
  return { file: host.execPath, prefixArgs: [script], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

export function resolveCommand(name: string, host: CommandHost): ResolvedCommand {
  const found = findOnPath(name, host);
  if (found === undefined) throw new CommandNotFoundError(name, pathDirs(host.env));
  const ext = extname(found).toLowerCase();
  if (host.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    const text = host.readText(found);
    const target = shimTarget(found, text);
    if (target !== undefined && host.exists(target)) {
      return /\.(js|cjs|mjs)$/i.test(target) ? nodeFor(target, host) : { file: target, prefixArgs: [] };
    }
    // Not npm's: a one-line wrapper someone wrote runs exactly the program it names.
    const plain = plainWrapperTarget(text);
    if (
      plain !== undefined &&
      host.exists(plain.program) &&
      (plain.script === undefined || host.exists(plain.script))
    ) {
      return { file: plain.program, prefixArgs: plain.script === undefined ? [] : [plain.script] };
    }
    throw new Error(
      `「${found}」不是认得的包装文件（npm 生成的，或一行「程序 [脚本] %*」），找不到它真正要运行的程序。`,
    );
  }
  if (/\.(js|cjs|mjs)$/i.test(found)) return nodeFor(found, host);
  return { file: found, prefixArgs: [] };
}
