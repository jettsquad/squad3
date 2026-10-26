// 移植自 Squad 2.x packages/seat-claude-code/src/doing.ts @ 8dcb903
/**
 * doing.ts — what a Claude Code seat has started and not finished.
 *
 * Read off the stream the CLI already writes, event by event. Every shape
 * here was captured from a live `claude -p --output-format stream-json` run
 * (2.1.295) rather than taken from documentation:
 *
 *   assistant  … tool_use {id, name, input}        a tool call begins
 *   user       … tool_result {tool_use_id}         that call returned
 *   system     task_started {task_id, tool_use_id, is_backgrounded}
 *   system     task_notification {task_id, status} a task ended
 *   system     task_updated {task_id, patch.status}
 *   system     background_tasks_changed {tasks}    the whole list, restated
 *
 * The background events are the reason this exists. A command run in the
 * background RETURNS at once — its tool call closes within a second — and the
 * turn then waits on it without writing another byte. Counting bytes, that is
 * indistinguishable from a seat that has gone: a full test suite was
 * cancelled as wedged at fifteen minutes, twice, taking the suite with it.
 * The stream had said the whole time that a task was still open.
 */
import { jsonLineFeeder, shownCommand, type OpenCommand, type StreamTracker } from "../../seat-runtime/index.ts";

interface Started {
  readonly tool: string;
  readonly command: string;
  readonly startedAt: number;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const blocks = (message: unknown): readonly Record<string, unknown>[] => {
  const content = record(message)["content"];
  return Array.isArray(content) ? content.map(record) : [];
};

/** States a task can be patched into that mean it is over. */
const ENDED = new Set(["completed", "failed", "killed", "stopped", "cancelled", "error"]);

/**
 * What a tool call should be shown as.
 *
 * A shell command is shown as written. Anything else is the tool's name and
 * the one argument that says what it is pointed at, because 「Read」 alone
 * tells a person nothing and the full input is a page.
 */
function describe(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") return shownCommand(text(input["command"]));
  const target = text(input["file_path"]) || text(input["url"]) || text(input["pattern"]) || text(input["description"]);
  return shownCommand(target === "" ? name : `${name} ${target}`);
}

/** The file a backgrounded command's output goes to, when the CLI named one. */
function outputFileIn(result: string): string | undefined {
  return /Output is being written to: (\S+?\.output)/.exec(result)?.[1];
}

/** The task id the CLI gave a command it sent to the background. */
function taskIdIn(result: string): string | undefined {
  return /\bID: ([A-Za-z0-9_-]+)/.exec(result)?.[1];
}

export function claudeTracker(): StreamTracker {
  /** Every tool call seen, so a later task event can say what it was running. */
  const calls = new Map<string, Started>();
  /** Tool calls that have not returned. */
  const foreground = new Map<string, OpenCommand>();
  /** Tasks the CLI started, by its own id, running or not. */
  const tasks = new Map<string, Started>();
  /** Tasks still running after their tool call returned. */
  const background = new Map<string, OpenCommand>();
  const outputFiles = new Map<string, string>();
  let lastWords: string | undefined;

  const openBackground = (taskId: string, fallback: string, at: number): void => {
    if (background.has(taskId)) return;
    const known = tasks.get(taskId);
    const file = outputFiles.get(taskId);
    background.set(taskId, {
      id: taskId,
      tool: known?.tool ?? "Bash",
      command: known?.command ?? shownCommand(fallback),
      startedAt: known?.startedAt ?? at,
      background: true,
      ...(file === undefined ? {} : { outputFile: file }),
    });
  };

  const feed = jsonLineFeeder((event, at) => {
    if (event["type"] === "assistant") {
      for (const block of blocks(event["message"])) {
        if (block["type"] === "text") {
          const said = text(block["text"]).trim();
          if (said !== "") lastWords = said;
        }
        if (block["type"] !== "tool_use") continue;
        const id = text(block["id"]);
        if (id === "") continue;
        const tool = text(block["name"]);
        const started = { tool, command: describe(tool, record(block["input"])), startedAt: at };
        calls.set(id, started);
        foreground.set(id, { id, ...started, background: false });
      }
      return;
    }

    if (event["type"] === "user") {
      for (const block of blocks(event["message"])) {
        if (block["type"] !== "tool_result") continue;
        foreground.delete(text(block["tool_use_id"]));
        // A command sent to the background says where its output is going in
        // the text it returns, and nowhere else. Kept so whoever has to judge
        // a quiet command can read what the command itself has printed.
        const content = block["content"];
        const said = typeof content === "string" ? content : JSON.stringify(content ?? "");
        const file = outputFileIn(said);
        const taskId = taskIdIn(said);
        if (file === undefined || taskId === undefined) continue;
        outputFiles.set(taskId, file);
        const open = background.get(taskId);
        if (open !== undefined) background.set(taskId, { ...open, outputFile: file });
      }
      return;
    }

    if (event["type"] !== "system") return;
    const subtype = event["subtype"];
    const taskId = text(event["task_id"]);

    if (subtype === "task_started" && taskId !== "") {
      const call = calls.get(text(event["tool_use_id"]));
      tasks.set(taskId, call ?? { tool: "Bash", command: shownCommand(text(event["description"])), startedAt: at });
      // The list that names a background task arrives BEFORE this event does,
      // so the task may already be open under its description. This is the
      // first moment the command itself is known: say that instead.
      const listed = background.get(taskId);
      if (listed !== undefined && call !== undefined) background.set(taskId, { ...listed, ...call });
      else if (event["is_backgrounded"] === true) openBackground(taskId, text(event["description"]), at);
      return;
    }
    if (subtype === "task_notification" && taskId !== "") {
      background.delete(taskId);
      return;
    }
    if (subtype === "task_updated" && taskId !== "") {
      if (ENDED.has(text(record(event["patch"])["status"]))) background.delete(taskId);
      return;
    }
    if (subtype === "background_tasks_changed" && Array.isArray(event["tasks"])) {
      // The CLI restating the whole list. Taken as the truth over whatever
      // was pieced together from the individual events: a command that timed
      // out in the foreground and was MOVED to the background appears here
      // without ever having announced itself as backgrounded.
      const listed = new Map(event["tasks"].map(record).map((task) => [text(task["task_id"]), task] as const));
      for (const id of [...background.keys()]) if (!listed.has(id)) background.delete(id);
      for (const [id, task] of listed) if (id !== "") openBackground(id, text(task["description"]), at);
    }
  });

  return {
    feed,
    open: () => [...foreground.values(), ...background.values()],
    lastWords: () => lastWords,
  };
}
