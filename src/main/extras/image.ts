// 移植自 Squad 2.x packages/console/src/image.ts @ 8dcb903（改动：路径包含判断改用 path.relative，Windows 可用）
/**
 * image.ts — a pasted image becomes a file the seats can open.
 *
 * Not a document: there is no text to extract, so it does not go through
 * `extractDocument`. What travels to a seat is a PATH, and the seat opens it
 * with the file tool it already has — every backend runs with the team's
 * folder as its cwd, so the file is simply there.
 *
 * The alternative was to send a real image block: dsh's subagent seam accepts
 * one (`ContentBlock` has an `image` member), but a provider that cannot take
 * it REFUSES the request — `subagent/attachment-invalid` — and that seat then
 * has no answer at all for the round. A path costs nothing to a seat that
 * cannot read images: it answers the text and says so.
 */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import { IMAGE_DIR } from "../../shared/local-media.ts";

/** Where pasted images live, under the team's own project folder. */
export { IMAGE_DIR };

/**
 * Extensions treated as images.
 *
 * By extension rather than by sniffing magic bytes: the name is what the
 * seat's file tool will use to decide how to open it, so agreeing with the
 * name is what keeps the two ends consistent.
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export function looksLikeImage(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * A name that cannot escape the folder or collide with what is already there.
 *
 * The clipboard hands over `image.png` every single time, so a timestamp is
 * not decoration — without it the second screenshot silently replaces the
 * first, and a material still pointing at the old one now shows the new.
 */
export function imageFileName(name: string, now = Date.now()): string {
  const ext = extname(name).toLowerCase() || ".png";
  const stem = name
    .slice(0, name.length - extname(name).length)
    .replace(/[/\\:*?"<>|\s]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 40);
  return `${now.toString(36)}-${stem === "" ? "image" : stem}${ext}`;
}

/**
 * What a seat reads instead of the picture.
 *
 * The last sentence is the one that matters. A seat told about a file it
 * cannot open will otherwise describe it anyway — this project has already
 * watched that happen with documents, where seats reported on files they had
 * never found. Saying "say so" costs one line and removes the whole failure.
 */
export function imagePointer(path: string): string {
  return [
    `（这是一张图片，不是文字。文件在：${path}`,
    `用你的读文件工具打开它再回答。`,
    `如果你打不开它，或者你读不了图片，就直说——不要猜它的内容。）`,
  ].join("\n");
}

/**
 * What keeps pasted screenshots out of the user's repository.
 *
 * A `.gitignore` INSIDE the folder, ignoring everything including itself.
 * The alternative is appending a line to the project's own `.gitignore`, and
 * that is an edit to a file the person owns and reads — made silently, by a
 * program they invited to hold a meeting. This way the whole directory is
 * invisible to git and nothing outside it is touched.
 *
 * These are screenshots of whatever was on screen when a question came up.
 * Treating them as private by default is the only defensible default.
 */
const GITIGNORE = ["# 粘贴进讨论的截图。整个目录对 git 不可见——包括这个文件本身。", "*", ""].join("\n");

/** Write the bytes into the team's image folder. Returns the absolute path. */
export async function saveImage(projectFolder: string, name: string, bytes: Uint8Array): Promise<string> {
  const dir = join(projectFolder, IMAGE_DIR);
  await mkdir(dir, { recursive: true });
  // Written every time rather than once at creation: a folder that lost its
  // ignore file — deleted by hand, or never written because an older build
  // made the folder — would start leaking screenshots into `git status` with
  // nothing to announce the change.
  await writeFile(join(dir, ".gitignore"), GITIGNORE);
  const path = join(dir, imageFileName(name));
  await writeFile(path, bytes);
  return path;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/**
 * Read one image the panel asked to show.
 *
 * The path arrives from a browser and originally from a model, so it is
 * trusted for nothing: it must be an image by extension, and — after symlinks
 * are resolved on BOTH sides — sit inside the team's own project folder. That
 * is wider than the two folders this product writes to, on purpose: an agent
 * that draws a diagram saves it under the project (`docs/…`), and that is the
 * picture the person wants to see. Only image files, only inside the folder
 * they gave the team; anything else is refused, not "not found", so a probe
 * for `/etc/passwd` and a typo do not look alike in the log.
 */
export async function readMedia(
  projectFolder: string,
  path: string,
): Promise<{ readonly bytes: Buffer; readonly contentType: string }> {
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()];
  if (contentType === undefined) throw new Error("不是图片。");
  const real = await realpath(path).catch(() => {
    throw new Error("找不到这张图片。");
  });
  const root = await realpath(projectFolder).catch(() => undefined);
  // `relative` rather than a prefix test: on Windows the same folder can come
  // back in a different letter case, and `J:\proj-x` is not inside `J:\proj`.
  const inside = root === undefined ? "" : relative(root, real);
  if (root === undefined || inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error("只能查看团队项目文件夹里的图片。");
  }
  return { bytes: await readFile(real), contentType };
}
