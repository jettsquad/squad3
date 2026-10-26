// 移植自 Squad 2.x packages/seat-runtime/src/download.ts @ 8e96d9c
/**
 * download.ts — fetch one file into the team's download folder, under rules
 * the model cannot argue with.
 *
 * Why this exists instead of pre-approving `curl`: a seat that may run `curl`
 * may also write anywhere and POST anything anywhere, and what steers it is a
 * web page it just read. Here the rules live in code the seat does not
 * control — HTTPS only, GET only, no private or loopback address, a size cap,
 * and exactly one place to write.
 *
 * Node builtins only: this module is loaded by a child process the seat's CLI
 * starts, outside the plugin host.
 */
import { lookup } from "node:dns";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { basename, extname, join } from "node:path";

export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 60_000;

/** Loopback, private, link-local, CGNAT, multicast and reserved — never a place a seat should be fetching from. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped !== null) return isPrivateAddress(mapped[1] as string);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      // 198.18.0.0/15 is deliberately NOT here. It is the benchmarking range,
      // and it is also what fake-IP proxies (Clash and its kin) hand back for
      // EVERY name: measured on this machine, www.w3.org resolved to
      // 198.18.1.3. Blocking it would make every download fail for anyone
      // behind one, and it is not an internal address — the proxy fetches the
      // real site on the far side.
      a >= 224
    );
  }
  const lower = address.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    /^fe[89ab]/.test(lower) ||
    lower.startsWith("ff")
  );
}

/** A name that cannot escape the folder or replace an earlier download. */
export function downloadFileName(requested: string | undefined, url: URL, now = Date.now()): string {
  const raw = (requested ?? "").trim() !== "" ? (requested as string) : basename(decodeURIComponent(url.pathname));
  const clean = basename(raw)
    .replace(/[/\\:*?"<>|\s]+/g, "-")
    .replace(/^[.-]+/, "");
  const ext = extname(clean).slice(0, 12);
  const stem = clean.slice(0, clean.length - extname(clean).length).slice(0, 60);
  return `${now.toString(36)}-${stem === "" ? "download" : stem}${ext}`;
}

export function parseDownloadUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`不是有效的 URL：${text}`);
  }
  if (url.protocol !== "https:") throw new Error("只允许 https:// 的地址。");
  if (url.username !== "" || url.password !== "") throw new Error("地址里不能带用户名或密码。");
  return url;
}

/** Validated at CONNECT time, so a name that resolves somewhere else a moment later cannot slip past. */
const guardedLookup: typeof lookup = ((hostname: string, options: unknown, callback: unknown) => {
  const done = (callback ?? options) as (error: Error | null, address?: unknown, family?: number) => void;
  const opts = typeof options === "object" && options !== null ? (options as object) : {};
  lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error !== null) return done(error);
    const list = addresses as unknown as readonly { address: string; family: number }[];
    const bad = list.find((entry) => isPrivateAddress(entry.address));
    if (bad !== undefined) return done(new Error(`${hostname} 解析到内网/保留地址 ${bad.address}，已拒绝。`));
    const wantsAll = (opts as { all?: boolean }).all === true;
    const first = list[0];
    if (first === undefined) return done(new Error(`${hostname} 没有解析结果。`));
    return wantsAll ? done(null, list) : done(null, first.address, first.family);
  });
}) as typeof lookup;

export interface Downloaded {
  readonly path: string;
  readonly bytes: number;
  readonly contentType: string;
}

/** Fetch `urlText` into `dir`. Throws a message a model can act on. */
export async function downloadFile(dir: string, urlText: string, requestedName?: string): Promise<Downloaded> {
  await mkdir(dir, { recursive: true });
  // Written every time: the folder holds whatever was on the web, and nothing
  // in it belongs in the person's repository.
  await writeFile(join(dir, ".gitignore"), "# 席位下载的文件。整个目录对 git 不可见。\n*\n");

  let url = parseDownloadUrl(urlText);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const outcome = await fetchOnce(url, dir, requestedName);
    if (outcome.kind === "saved") return outcome.file;
    url = parseDownloadUrl(new URL(outcome.location, url).toString());
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次。`);
}

type Outcome =
  { readonly kind: "saved"; readonly file: Downloaded } | { readonly kind: "redirect"; readonly location: string };

function fetchOnce(url: URL, dir: string, requestedName: string | undefined): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        headers: { "user-agent": "Mozilla/5.0 (compatible; SquadDownload/1.0)", accept: "*/*" },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && typeof res.headers.location === "string") {
          res.resume();
          resolve({ kind: "redirect", location: res.headers.location });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`服务器返回 ${status}。`));
          return;
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > MAX_DOWNLOAD_BYTES) {
          res.resume();
          reject(new Error(`文件太大（${declared} 字节，上限 ${MAX_DOWNLOAD_BYTES}）。`));
          return;
        }
        const target = join(dir, downloadFileName(requestedName, url));
        const partial = `${target}.part`;
        const out = createWriteStream(partial);
        let bytes = 0;
        const fail = (error: Error): void => {
          out.destroy();
          void rm(partial, { force: true });
          reject(error);
        };
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_DOWNLOAD_BYTES) {
            res.destroy();
            fail(new Error(`文件超过上限 ${MAX_DOWNLOAD_BYTES} 字节，已中止。`));
          }
        });
        res.on("error", fail);
        out.on("error", fail);
        out.on("finish", () => {
          rename(partial, target).then(
            () =>
              resolve({
                kind: "saved",
                file: { path: target, bytes, contentType: String(res.headers["content-type"] ?? "") },
              }),
            reject,
          );
        });
        res.pipe(out);
      },
    );
    req.on("timeout", () => req.destroy(new Error("下载超时。")));
    req.on("error", reject);
    req.end();
  });
}
