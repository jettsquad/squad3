import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compose } from "../src/main/compose.ts";
import { createDispatcher } from "../src/main/ipc/index.ts";
import { cloudExecutions } from "../src/main/seats/cloud/executions.ts";

it("retains execution evidence and refuses reconciliation of active or replaced records", async () => {
  const root = await mkdtemp(join(tmpdir(), "squad-execution-review-"));
  try {
    const directory = join(root, "cloud-pending");
    await mkdir(directory);
    const id = "a".repeat(64);
    const file = join(directory, id + ".json");
    await writeFile(file, JSON.stringify({ state: "pending" }));
    const active = new Set([file]);
    const executions = cloudExecutions(root, active);
    const first = executions.list().records[0]!;
    expect(first.state).toBe("running");
    expect(() => executions.reconcile(id, first.version, "checked")).toThrow("仍在运行");
    active.clear();
    await writeFile(file, JSON.stringify({ state: "completedAwaitingCloud", stdout: "written", exitCode: 0 }));
    expect(() => executions.reconcile(id, first.version, "checked")).toThrow("已变化");
    const completed = executions.list().records[0]!;
    expect(completed).toMatchObject({ state: "completed", exitCode: 0, stdout: "written" });
    executions.reconcile(id, completed.version, "verified output");
    expect(executions.list()).toMatchObject({ records: [], recent: [{ note: "verified output" }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects stale artifact feedback and routes a valid batch to exactly the selected seat", async () => {
  const root = await mkdtemp(join(tmpdir(), "squad-artifact-review-"));
  const projectFolder = join(root, "project");
  await mkdir(projectFolder);
  const app = compose({
    name: "Squad",
    version: "test",
    dataDir: join(root, "data"),
    cipher: { available: () => true, encrypt: (s) => Buffer.from(s), decrypt: (bytes) => bytes.toString() },
    pickFolder: async () => null,
    pickFiles: async () => [],
    push: () => undefined,
  });
  try {
    const dispatch = createDispatcher(app.handlers);
    const { teamId } = app.table.create({
      displayName: "Review",
      projectFolder,
      seats: ["甲", "乙"].map((displayName) => ({
        displayName,
        role: "Reviewer",
        systemPrompt: "Review",
        backend: "codex",
      })),
    });
    const [first, second] = app.table.list().teams[0]!.seats;
    const file = join(projectFolder, "report.md");
    await writeFile(file, "old\n");
    const old = await app.handlers["artifacts.read"]({ teamId, path: "report.md" });
    await writeFile(file, "new\n");
    const payload = {
      teamId,
      path: "report.md",
      version: old.version,
      seatId: first!.seatId,
      comments: [{ from: 1, to: 1, note: "请检查 @乙 的表述。" }],
    };
    expect(await dispatch("artifacts.feedback", payload)).toMatchObject({ ok: false });
    expect(await dispatch("artifacts.read", { teamId, path: "../outside.md" })).toMatchObject({ ok: false });
    const current = await app.handlers["artifacts.read"]({ teamId, path: "report.md" });
    const sent = await dispatch("artifacts.feedback", { ...payload, version: current.version });
    expect(sent).toMatchObject({ ok: true });
    const journal = await readFile(join(root, "data", "teams", teamId, "log.jsonl"), "utf8");
    const messages = journal
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "host/message");
    expect(messages).toMatchObject([{ seatIds: [first!.seatId] }]);
    expect(second?.seatId).not.toBe(first!.seatId);
  } finally {
    await app.table.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
