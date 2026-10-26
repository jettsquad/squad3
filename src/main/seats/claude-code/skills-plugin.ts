// 移植自 Squad 2.x packages/seat-claude-code/src/skills-plugin.ts @ 8dcb903
/**
 * skills-plugin.ts — the shared skills folder, as something an isolated
 * Claude Code seat can be handed.
 *
 * Skills are installed ONCE, in `~/.agents/skills` — the cross-tool location
 * dsh scans natively and Codex reads too. A Claude Code seat cannot be
 * pointed at it directly: the only way in for a seat started without the
 * host's own configuration is `--plugin-dir`, and a plugin is a folder with
 * a manifest and a `skills/` directory. So this builds that folder, with
 * `skills/` a link to the shared one.
 *
 * A link rather than a copy, so a skill added or edited in the shared folder
 * is what the next seat sees, with nothing to re-run.
 *
 * Only the catalogue reaches the seat's context — each skill's name and its
 * one-line description. A body is read when the seat decides to use it. That
 * is the difference from pasting a skill into a prompt block, which grows
 * every seat's prompt by every skill whether it is used or not.
 */
import { lstat, mkdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The name the plugin registers under; skills appear as `squad:<skill>`. */
export const SKILLS_PLUGIN_NAME = "squad";

/**
 * Where shared skills live.
 *
 * `DSH_AGENTS_HOME` is read because dsh reads it: the two must agree on the
 * folder, or a dsh seat and a Claude seat at one table see different skills.
 */
export function sharedSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["DSH_AGENTS_HOME"];
  const home = configured !== undefined && configured.trim() !== "" ? configured.trim() : join(homedir(), ".agents");
  return join(resolve(home), "skills");
}

/**
 * Make sure the plugin folder exists and points at the shared skills.
 *
 * @param pluginDir where to build it — under the seat state directory.
 * @returns the folder to pass to `--plugin-dir`, or nothing when there are no
 *   shared skills to offer. Never throws: a seat that cannot be given skills
 *   still runs, it simply has none.
 */
export async function ensureSkillsPlugin(
  pluginDir: string,
  skillsDir: string = sharedSkillsDir(),
): Promise<string | undefined> {
  try {
    if (!(await stat(skillsDir)).isDirectory()) return undefined;
    await mkdir(join(pluginDir, ".claude-plugin"), { recursive: true });
    await writeFile(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        { name: SKILLS_PLUGIN_NAME, version: "1.0.0", description: "Skills shared with Squad seats" },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const link = join(pluginDir, "skills");
    const existing = await lstat(link).catch(() => undefined);
    const current = existing?.isSymbolicLink() === true ? await readlink(link).catch(() => undefined) : undefined;
    if (current !== skillsDir) {
      // Whatever is there is not the link we want: an old link to a folder
      // that moved, or something left by hand.
      if (existing !== undefined) await rm(link, { recursive: true, force: true });
      await symlink(skillsDir, link, process.platform === "win32" ? "junction" : "dir");
    }
    return pluginDir;
  } catch {
    return undefined;
  }
}
