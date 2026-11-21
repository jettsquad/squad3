import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MethodOutput } from "../../../shared/wire.ts";

type RecordView = MethodOutput<"cloud.executions">["records"][number];

export function cloudExecutions(stateDir: string, active: ReadonlySet<string>) {
  const directory = join(stateDir, "cloud-pending");
  function read(id: string): RecordView {
    const file = join(directory, id + ".json");
    const raw = readFileSync(file, "utf8");
    const version = createHash("sha256").update(raw).digest("hex");
    const running = active.has(file);
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const state = data["state"];
      const string = (key: string) => (typeof data[key] === "string" ? data[key] : undefined);
      return {
        id,
        version,
        at: typeof data["at"] === "number" ? data["at"] : 0,
        state: running
          ? "running"
          : state === "completedAwaitingCloud"
            ? "completed"
            : state === "pending"
              ? "unknown"
              : "unreadable",
        project: string("project"),
        callId: string("callId"),
        digest: string("digest"),
        stdout: string("stdout"),
        stderr: string("stderr"),
        exitCode: typeof data["exitCode"] === "number" ? data["exitCode"] : undefined,
      };
    } catch {
      return { id, version, at: 0, state: running ? "running" : "unreadable" };
    }
  }
  function filesIn(folder: string): string[] {
    try {
      return readdirSync(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  const archive = join(stateDir, "cloud-reconciled");
  return {
    list: (): MethodOutput<"cloud.executions"> => ({
      records: filesIn(directory)
        .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
        .map((file) => read(file.slice(0, -5)))
        .sort((a, b) => b.at - a.at),
      recent: filesIn(archive)
        .filter((file) => /^\d{13}-[a-f0-9-]{36}\.json$/.test(file))
        .sort()
        .reverse()
        .slice(0, 10)
        .map((id) => {
          const { project, note, reviewedAt } = JSON.parse(readFileSync(join(archive, id), "utf8")) as {
            project?: string;
            note: string;
            reviewedAt: number;
          };
          return { id, project, note, reviewedAt };
        }),
    }),
    reconcile: (id: string, version: string, note: string): void => {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("云端执行记录编号无效。");
      const record = read(id);
      if (record.state === "running") throw new Error("这条记录仍在运行，结束后才能核对。");
      if (record.version !== version) throw new Error("记录已变化，请刷新后重新核对。");
      mkdirSync(archive, { recursive: true });
      const reviewedAt = Date.now();
      writeFileSync(
        join(archive, `${reviewedAt}-${randomUUID()}.json`),
        JSON.stringify({ ...record, reviewedAt, note }),
        { flag: "wx", mode: 0o600 },
      );
      rmSync(join(directory, id + ".json"));
    },
  };
}
