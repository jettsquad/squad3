// 移植自 Squad 2.x packages/seat-runtime/src/download-tool.ts @ 8e96d9c
// 改动：服务器由 Electron 自己以 Node 模式起（ELECTRON_RUN_AS_NODE），不要求本机另装 Node；
// 打包后脚本在 out/main 里，和打包好的主进程代码同一个目录。
/**
 * download-tool.ts — how a seat backend finds and names the download server.
 *
 * Resolved from this module's own URL, for the reason the heartbeat's path is:
 * a seat runs with the TEAM's folder as its cwd. `.ts` beside this source in a
 * checkout, `.js` beside the emitted file in the published bundle.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOWNLOAD_DIR } from "../../shared/local-media.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Installed, the main bundle sits inside `app.asar`, and the script is
 * unpacked beside it (`app.asar.unpacked`, see electron-builder.yml): the
 * process that runs it is started by a seat's CLI, and reads it from disk.
 */
const UNPACKED = HERE.replace(/app\.asar(?=[\\/]|$)/, "app.asar.unpacked");
const SCRIPT =
  [join(UNPACKED, "download-mcp.js"), join(HERE, "download-mcp.ts"), join(HERE, "download-mcp.js")].find((path) =>
    existsSync(path),
  ) ?? join(HERE, "download-mcp.js");

/** The `--mcp-config` JSON that mounts the download tool, writing under `<cwd>/squad-downloads`. */
export function downloadMcpConfig(cwd: string, server: string): string {
  return JSON.stringify({
    mcpServers: {
      [server]: {
        command: process.execPath,
        args: [SCRIPT, join(cwd, DOWNLOAD_DIR)],
        // Inside the app, `process.execPath` is Electron itself; this makes
        // it behave as Node for the server. Harmless when it already is Node.
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
  });
}
