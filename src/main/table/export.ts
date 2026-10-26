// 移植自 Squad 2.x packages/table/src/export.ts @ 8dcb903（改动：TranscriptEvent 的形状在这里声明，3 没有 dsh 的 log.ts）
/**
 * export.ts — a readable copy of a discussion, kept in the project it is about.
 *
 * A COPY. The record itself lives in Squad's own folder, where the seats —
 * who run inside the project with tools that read and write files — cannot
 * rewrite what they are on record as having said. This is for the person:
 * something to read, search, and back up along with the project, and what a
 * discussion can be recovered from if Squad's own folder is ever lost.
 *
 * One way only. Editing or deleting one of these changes nothing about the
 * discussion, and the next export puts it back.
 */
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
/** One recorded line as the export reads it: 【speaker】text. */
export interface TranscriptEvent {
  readonly kind: string;
  readonly text: string;
  readonly at: number;
}

/** The folder inside a project that holds Squad's exports. */
export const EXPORT_FOLDER = ".squad";

const stamp = (at: number): string => {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
};

/**
 * One discussion as Markdown. Pure.
 *
 * Only what was SAID: the record also carries dsh's bookkeeping events, which
 * mean nothing to a reader.
 */
export function renderDiscussion(input: {
  readonly teamName: string;
  readonly teamId: string;
  readonly events: readonly TranscriptEvent[];
  readonly exportedAt: number;
}): string {
  const spoken = input.events.filter((event) => event.kind === "user/message" && event.text.trim() !== "");
  const lines = [
    `# ${input.teamName} · 讨论记录`,
    "",
    "> Squad 自动导出的只读副本，每轮讨论结束后更新。",
    "> 正本在 Squad 自己的数据目录里：改动或删除这个文件不会改变讨论，下次导出会把它覆盖回来。",
    `> 场次 ${input.teamId} · 共 ${spoken.length} 条 · 导出于 ${stamp(input.exportedAt)}`,
  ];
  for (const event of spoken) {
    const match = /^【(.+?)】([\s\S]*)$/.exec(event.text);
    const speaker = match?.[1] ?? "记录";
    const body = (match?.[2] ?? event.text).trim();
    lines.push("", `## ${speaker} · ${stamp(event.at)}`, "", body);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write one discussion's copy into its project.
 *
 * Skipped when the project folder is not there — a project on a drive that
 * is not mounted is not a reason to create a folder where it would have been.
 *
 * The folder ignores itself: a `.gitignore` holding `*`, written once, so a
 * discussion never rides along on a `git add -A` into a repository it was
 * about rather than part of.
 */
export async function writeDiscussion(projectFolder: string, teamId: string, markdown: string): Promise<void> {
  if (projectFolder.trim() === "" || !existsSync(projectFolder)) return;
  const root = join(projectFolder, EXPORT_FOLDER);
  const folder = join(root, "discussions");
  await mkdir(folder, { recursive: true });
  const ignore = join(root, ".gitignore");
  if (!existsSync(ignore)) {
    await writeFile(ignore, "# Squad 导出的讨论副本。整个目录不进版本库。\n*\n", "utf8");
  }
  // Written beside and renamed: a reader never opens half a file.
  const target = join(folder, `${teamId}.md`);
  const partial = `${target}.partial`;
  await writeFile(partial, markdown, "utf8");
  await rename(partial, target);
}

/**
 * Write a completion report into the project's `.squad/reports/`.
 *
 * Same folder and same self-ignoring rule as the discussions: a copy for the
 * person to read, never something the team's work depends on.
 *
 * @returns the path relative to the project folder.
 */
export async function writeReport(projectFolder: string, name: string, markdown: string): Promise<string> {
  const root = join(projectFolder, EXPORT_FOLDER);
  await mkdir(join(root, "reports"), { recursive: true });
  const ignore = join(root, ".gitignore");
  if (!existsSync(ignore)) {
    await writeFile(ignore, "# Squad 导出的讨论副本。整个目录不进版本库。\n*\n", "utf8");
  }
  const relative = join(EXPORT_FOLDER, "reports", `${name}.md`);
  await writeFile(join(projectFolder, relative), markdown, "utf8");
  return relative;
}
