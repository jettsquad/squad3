// 移植自 Squad 2.x packages/seat-runtime/src/download-mcp.ts @ 8e96d9c
// 改动：判断「自己是不是入口」用 pathToFileURL——2.x 拼 `file://` + 路径，Windows 的盘符路径拼出来不对，
// 服务器就永远不开始读 stdin。3 里它是主进程构建的第二个入口（out/main/download-mcp.js）。
/**
 * download-mcp.ts — the `download_file` tool, as a stdio MCP server.
 *
 * Started by a seat's CLI (`--mcp-config`), never by the plugin host, so it
 * is its own entry point and imports nothing from the framework. The folder it
 * may write to is fixed by ITS ARGUMENT, not by anything the model sends.
 *
 * Hand-rolled JSON-RPC over newline-delimited stdio: the protocol surface a
 * single tool needs is four methods, which is less than the dependency.
 */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { downloadFile, type Downloaded } from "./download.ts";

export const DOWNLOAD_SERVER = "squad-download";
export const DOWNLOAD_TOOL = "download_file";

const TOOL = {
  name: DOWNLOAD_TOOL,
  description:
    "Download a file (PDF, datasheet, image, archive…) from an https:// URL into the team's download folder and " +
    "return its absolute path. Use this instead of WebFetch when you need the file itself rather than a text " +
    "summary. https only; private addresses are refused; 100 MB cap.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "https:// address of the file" },
      filename: { type: "string", description: "optional name to save it under (no folders)" },
    },
    required: ["url"],
  },
} as const;

interface Rpc {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

type Download = (url: string, filename: string | undefined) => Promise<Downloaded>;

/** One request in, the reply out (undefined for a notification). Pure but for `download`. */
export async function handleRpc(message: Rpc, download: Download): Promise<object | undefined> {
  const reply = (result: object): object => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code: number, text: string): object => ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code, message: text },
  });
  if (message.id === undefined) return undefined;
  switch (message.method) {
    case "initialize":
      return reply({
        protocolVersion: (message.params?.protocolVersion as string | undefined) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: DOWNLOAD_SERVER, version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      if (message.params?.name !== DOWNLOAD_TOOL) return fail(-32602, `未知工具：${String(message.params?.name)}`);
      const args = (message.params?.arguments ?? {}) as { url?: unknown; filename?: unknown };
      try {
        if (typeof args.url !== "string") throw new Error("缺少 url。");
        const file = await download(args.url, typeof args.filename === "string" ? args.filename : undefined);
        return reply({
          content: [
            {
              type: "text",
              text: `已保存：${file.path}\n大小：${file.bytes} 字节\n类型：${file.contentType || "未知"}`,
            },
          ],
        });
      } catch (error) {
        return reply({ isError: true, content: [{ type: "text", text: `下载失败：${(error as Error).message}` }] });
      }
    }
    default:
      return fail(-32601, `不支持：${String(message.method)}`);
  }
}

/** Only when run as the entry point — importing this file for its handler must not start reading stdin. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (dir === undefined || dir === "") {
    process.stderr.write("usage: download-mcp <download-dir>\n");
    process.exit(2);
  }
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message: Rpc;
    try {
      message = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    void handleRpc(message, (url, filename) => downloadFile(dir, url, filename)).then((response) => {
      if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
}
