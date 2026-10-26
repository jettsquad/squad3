// 移植自 Squad 2.x packages/reasoning/src/store.ts @ 8dcb903
/**
 * store.ts — a directory of plain text, and why it is not a database.
 *
 * The requirement is blunt: one directory, plain text files, manageable with
 * git, readable after Squad is gone. This is the user's own asset — the
 * design calls it worth more than any single project — so it must survive a
 * new machine, a reinstall, and this project being abandoned. A record only
 * readable through the tool that wrote it fails that on the first of those.
 *
 * The layout carries the export boundary rather than restating it:
 *
 *   criteria/   abstracts   — transferable, may be given away or shared
 *   instances/  occurrences — the user's own, with project detail, never leave
 *   proposals/  awaiting the human's verdict
 *
 * "Abstract exportable, instance not" is then a fact about which directory a
 * file is in, not a rule some future export routine has to remember. One
 * decision doing two jobs, which is why nothing here needs a privacy flag.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  criterionFromMarkdown,
  criterionToMarkdown,
  instanceToMarkdown,
  type Criterion,
  type Instance,
} from "./criterion.ts";
import { emptyUsage, usageFromMarkdown, usageToMarkdown, type UsageRecord } from "./usage.ts";

export const CRITERIA_DIR = "criteria";
export const INSTANCES_DIR = "instances";
export const PROPOSALS_DIR = "proposals";
/**
 * Usage sits with instances on the local side of the export boundary. Given
 * someone else's abstract you should not receive their delivery counts, and
 * giving yours away should not hand over how you have been working.
 */
export const USAGE_DIR = "usage";

/**
 * One user's criteria library.
 *
 * One user, one directory, physically. Today there is one user, but the
 * boundary is physical from the first day — `contextMode: independent`
 * taught this project that isolation by good intentions is not isolation.
 */
export class ReasoningStore {
  private readonly root: string;
  /** Per-criterion write chains; see `updateUsage`. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = root;
  }

  async init(): Promise<void> {
    for (const dir of [CRITERIA_DIR, INSTANCES_DIR, PROPOSALS_DIR, USAGE_DIR]) {
      await mkdir(join(this.root, dir), { recursive: true });
    }
  }

  /**
   * Every criterion in the library.
   *
   * A file that will not parse takes the whole read down, naming itself. The
   * alternative — skip it and carry on — means the library quietly holds
   * fewer criteria than the directory does, and the one that vanished is the
   * one nobody will think to look for.
   */
  async criteria(): Promise<readonly Criterion[]> {
    const dir = join(this.root, CRITERIA_DIR);
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".md")).sort();
    const all: Criterion[] = [];
    for (const name of names) {
      all.push(criterionFromMarkdown(await readFile(join(dir, name), "utf8"), name));
    }
    return all;
  }

  async putCriterion(criterion: Criterion): Promise<void> {
    await mkdir(join(this.root, CRITERIA_DIR), { recursive: true });
    await writeFile(join(this.root, CRITERIA_DIR, `${criterion.id}.md`), criterionToMarkdown(criterion), "utf8");
  }

  async putInstance(instance: Instance): Promise<void> {
    await mkdir(join(this.root, INSTANCES_DIR), { recursive: true });
    await writeFile(join(this.root, INSTANCES_DIR, `${instance.id}.md`), instanceToMarkdown(instance), "utf8");
  }

  /** Proposals are criteria that have not been adjudicated yet. Same format. */
  async proposals(): Promise<readonly Criterion[]> {
    const dir = join(this.root, PROPOSALS_DIR);
    const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".md")).sort();
    const all: Criterion[] = [];
    for (const name of names) {
      all.push(criterionFromMarkdown(await readFile(join(dir, name), "utf8"), name));
    }
    return all;
  }

  async putProposal(criterion: Criterion): Promise<void> {
    await mkdir(join(this.root, PROPOSALS_DIR), { recursive: true });
    await writeFile(join(this.root, PROPOSALS_DIR, `${criterion.id}.md`), criterionToMarkdown(criterion), "utf8");
  }

  async dropProposal(id: string): Promise<void> {
    await rm(join(this.root, PROPOSALS_DIR, `${id}.md`), { force: true });
  }

  /**
   * Remove a criterion from the live library.
   *
   * Only ever called as the second half of moving one back to `proposals/` —
   * a criterion the human wants to re-decide. Nothing else deletes from here:
   * withdrawing a judgement is `status: retired`, which keeps the file and the
   * reasons in it readable, and losing that text would take the evidence with
   * it.
   */
  async dropCriterion(id: string): Promise<void> {
    await rm(join(this.root, CRITERIA_DIR, `${id}.md`), { force: true });
  }

  /** One criterion's usage, or a zeroed record when it has none yet. */
  async usage(criterionId: string): Promise<UsageRecord> {
    const path = join(this.root, USAGE_DIR, `${criterionId}.md`);
    const text = await readFile(path, "utf8").catch(() => undefined);
    return text === undefined ? emptyUsage(criterionId) : usageFromMarkdown(text, `${criterionId}.md`);
  }

  /**
   * Read-modify-write one usage record.
   *
   * Serialised per criterion through a promise chain: two deliveries landing
   * together would otherwise both read the same count and both write back
   * that same number plus one, losing a delivery. An undercount here is
   * invisible — it looks exactly like a criterion that was recalled less
   * often, which is precisely the signal the first scale exists to give.
   */
  async updateUsage(criterionId: string, change: (current: UsageRecord) => UsageRecord): Promise<UsageRecord> {
    const previous = this.writes.get(criterionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const current = await this.usage(criterionId);
      const updated = change(current);
      await mkdir(join(this.root, USAGE_DIR), { recursive: true });
      await writeFile(join(this.root, USAGE_DIR, `${criterionId}.md`), usageToMarkdown(updated), "utf8");
      return updated;
    });
    this.writes.set(
      criterionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
