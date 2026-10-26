/**
 * project-memory.ts — the project's own notes file, read by Squad and handed to a fresh seat.
 *
 * 移植自 Squad 2.x packages/table/src/service.ts 的 projectMemoryFor / compacted，
 * 以及 packages/table/src/project-memory.ts 的 ensureProjectMemoryFile @ 8e96d9c
 * 改动：从服务类里拆成独立函数；精简交给上下文层（它握着秘书），由调用方传入；
 * 建文件用同步写（席位按名册顺序起，异步会让先回来的磁盘答复先走）。
 *
 * Squad reads it rather than the CLI: the switch that stops `claude` reading
 * the project's `CLAUDE.md` is the same one that stops it reading the host's
 * whole configuration, and only one of those is worth paying for on every
 * cold start. Handing it over ourselves is visible on screen and sent once
 * per conversation.
 *
 * Checked per turn rather than remembered: the folder is the person's and
 * they may delete the file. A backend with no such convention, or a file that
 * cannot be read, produces nothing — this is a convenience and must never be
 * the reason a round fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  initialProjectMemory,
  PROJECT_MEMORY_MAX_CHARS,
  projectMemoryFile,
  withProjectMemoryRules,
} from "../../shared/index.ts";
import type { SeatSpec } from "../../shared/seat.ts";

export interface ProjectMemory {
  readonly file: string;
  readonly text: string;
  /** Squad wrote the minimal file this turn: said once in the record. */
  readonly created: boolean;
}

/** path → the rewrite in flight, so the seats of one round wait for one rewrite instead of starting several. */
const compactions = new Map<string, Promise<string>>();

/**
 * The team's own notes file, created as a minimal template when it is missing.
 *
 * 2.x first had the seat write it on its first turn, and a seat asked for
 * 「the project's background」 in an empty folder went looking for one — in
 * the parent folder, in sibling projects — and wrote somebody else's facts
 * into this one. Now Squad writes only what it knows: where the project is,
 * and that nothing else has been confirmed yet. `wx`, so two seats starting
 * together cannot both create it.
 */
export function ensureProjectMemoryFile(folder: string, file: string): { text: string; created: boolean } {
  const path = join(folder, file);
  try {
    return { text: readFileSync(path, "utf8"), created: false };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const text = initialProjectMemory(folder);
  try {
    writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
    return { text, created: true };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return { text: readFileSync(path, "utf8"), created: false };
  }
}

export async function projectMemoryFor(
  folder: string,
  seat: SeatSpec,
  compact: (file: string, text: string) => Promise<string | undefined>,
): Promise<ProjectMemory | undefined> {
  const file = projectMemoryFile(seat.backend);
  if (file === undefined || folder.trim() === "") return undefined;
  const path = join(folder, file);
  // Read synchronously: seats of one command start in roster order, which is
  // speaking order, and an async read here let whichever disk answer came
  // back first go first. The file is small by rule (15k characters).
  try {
    const { text, created } = ensureProjectMemoryFile(folder, file);
    if (text.trim() === "") return undefined;
    return { file, text: await compacted(path, file, text, compact), created };
  } catch {
    // There and unreadable, or not writable: the seat loses a convenience;
    // failing the round would lose the answer.
    return undefined;
  }
}

/**
 * The file, shrunk back under its limit first when it has outgrown it. Done,
 * not reported: telling the person hands them a job they would only give back
 * to a Claude. The project's own history keeps the old version.
 */
async function compacted(
  path: string,
  file: string,
  text: string,
  compact: (file: string, text: string) => Promise<string | undefined>,
): Promise<string> {
  if (text.length <= PROJECT_MEMORY_MAX_CHARS) return text;
  const running = compactions.get(path);
  if (running !== undefined) return running;
  const work = (async (): Promise<string> => {
    const body = await compact(file, text);
    if (body === undefined) return text;
    const next = withProjectMemoryRules(body);
    await writeFile(path, next, "utf8");
    return next;
  })();
  compactions.set(path, work);
  try {
    return await work;
  } catch (error) {
    console.warn(`精简 ${file} 失败，这一轮照原文发：${error instanceof Error ? error.message : String(error)}`);
    return text;
  } finally {
    compactions.delete(path);
  }
}
