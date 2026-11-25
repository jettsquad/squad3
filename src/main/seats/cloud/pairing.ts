import { execFile } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { access, mkdir, writeFile } from "node:fs/promises";
import { Agent, request } from "node:https";
import { join } from "node:path";
import { connect } from "node:tls";
import { promisify } from "node:util";
import { z } from "zod";
import type { SeatConnection } from "../../../shared/connection.ts";
import type { ResolvedCommand } from "../../seat-runtime/index.ts";
import { cloudSshArgs } from "./adapter.ts";

const run = promisify(execFile);
const pairResponse = z.object({
  deviceId: z.string().regex(/^[a-f0-9]{32}$/),
  sshKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/=]+$/),
  sshPort: z.number().int().min(1024).max(65535),
  sshHost: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/),
});
const statusResponse = z.object({
  state: z.enum(["active", "paused", "revoked", "expired"]),
  expiresAt: z.number().nullable(),
});

function redeem(host: string, port: number, fingerprint: string, body: string): Promise<unknown> {
  const agent = new Agent({ maxSockets: 1 });
  agent.createConnection = (_options, callback) => {
    const socket = connect({ host, port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    const timeout = setTimeout(() => socket.destroy(new Error("配对握手超时。")), 8000);
    const failed = (error: Error) => {
      clearTimeout(timeout);
      callback?.(error, socket);
    };
    socket.once("error", failed);
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      const actual = socket.getPeerCertificate().fingerprint256?.replaceAll(":", "").toLowerCase();
      if (
        actual === undefined ||
        actual.length !== fingerprint.length ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(fingerprint))
      ) {
        socket.destroy(new Error("配对服务器的身份与配对码不一致。"));
        return;
      }
      socket.removeListener("error", failed);
      callback?.(null, socket);
    });
    return undefined;
  };
  return new Promise<unknown>((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        method: "POST",
        path: "/trial",
        agent,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (part: string) => {
          raw += part;
          if (raw.length > 16000) req.destroy(new Error("配对响应过大。"));
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error("服务器暂未受理云端试用，请稍后重试或联系管理员。"));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error("配对响应无法识别。"));
          }
        });
      },
    );
    const timeout = setTimeout(() => req.destroy(new Error("配对请求超时。")), 15000);
    req.on("error", reject);
    req.once("close", () => {
      clearTimeout(timeout);
      agent.destroy();
    });
    req.end(body);
  });
}

export function activateCloudDevice(stateDir: string, resolve: (program: string) => ResolvedCommand) {
  const address = process.env.SQUAD_DEVICE_GATEWAY ?? "";
  const matched = /^([A-Za-z0-9][A-Za-z0-9.-]{0,252}):(\d{1,5}):([0-9a-f]{64})$/.exec(address);
  if (matched === null) throw new Error("此版本未配置默认云端服务。");
  const [, host = "", rawPort, fingerprint = ""] = matched;
  const port = Number(rawPort);
  if (port < 1 || port > 65535) throw new Error("默认云端服务端口无效。");
  const profile = createHash("sha256")
    .update(JSON.stringify([host, port]))
    .digest("hex");
  return register(join(stateDir, "devices", "trial", profile), resolve, host, port, fingerprint);
}

async function register(
  profile: string,
  resolve: (program: string) => ResolvedCommand,
  host: string,
  port: number,
  fingerprint: string,
): Promise<SeatConnection> {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const identityFile = join(profile, "id_ed25519");
  const knownHostsFile = join(profile, "known_hosts");
  {
    const keygen = resolve("ssh-keygen");
    const present = await access(identityFile).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (!present)
      await run(keygen.file, [...keygen.prefixArgs, "-q", "-t", "ed25519", "-N", "", "-f", identityFile], {
        windowsHide: true,
        timeout: 10000,
      });
    const { stdout } = await run(keygen.file, [...keygen.prefixArgs, "-y", "-f", identityFile], {
      windowsHide: true,
      timeout: 10000,
    });
    const publicKey = stdout.trim().split(/\s+/).slice(0, 2).join(" ");
    const body = JSON.stringify({ publicKey, name: hostname().slice(0, 80) });
    const result = pairResponse.parse(await redeem(host, port, fingerprint, body));
    await writeFile(knownHostsFile, `[${result.sshHost}]:${result.sshPort} ${result.sshKey}\n`, { mode: 0o600 });
    return {
      connectionId: `device-${result.deviceId}`,
      displayName: "云端 MiniMax",
      authMode: "api-key",
      source: "octopus",
      cloud: {
        host: result.sshHost,
        port: result.sshPort,
        user: "squad-gateway",
        runAs: "octopus-g0",
        executable: "/opt/octopus-g0/bin/codex-minimax",
        revision: "1",
        identityFile,
        knownHostsFile,
        quotaProvider: "minimax",
        managedDeviceId: result.deviceId,
      },
    };
  }
}

export async function cloudDeviceStatus(connection: SeatConnection, resolve: (program: string) => ResolvedCommand) {
  if (connection.cloud?.managedDeviceId === undefined) throw new Error("请选择已配对的设备连接。");
  const ssh = resolve("ssh");
  try {
    const { stdout } = await run(ssh.file, [...ssh.prefixArgs, ...cloudSshArgs(connection, "status")], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8192,
    });
    return statusResponse.parse(JSON.parse(stdout));
  } catch {
    throw new Error("无法查询使用期限，请检查云端连接。");
  }
}

const subscriptionResponse = statusResponse.extend({
  request: z
    .object({
      term: z.enum(["month", "year"]),
      status: z.enum(["pending", "approved", "rejected"]),
      requestedAt: z.number(),
    })
    .nullable(),
});

export async function cloudSubscription(
  connection: SeatConnection,
  resolve: (program: string) => ResolvedCommand,
  term?: "month" | "year",
) {
  if (connection.cloud?.managedDeviceId === undefined) throw new Error("请选择已开通的云端设备连接。");
  const ssh = resolve("ssh");
  try {
    const operation = term === undefined ? "subscription" : term === "month" ? "subscribe-month" : "subscribe-year";
    const { stdout } = await run(ssh.file, [...ssh.prefixArgs, ...cloudSshArgs(connection, operation)], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8192,
    });
    return subscriptionResponse.parse(JSON.parse(stdout));
  } catch {
    throw new Error(term === undefined ? "无法查询订阅，请检查云端连接。" : "申请未确认，请刷新订阅状态后重试。");
  }
}
