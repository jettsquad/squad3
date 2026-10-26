/**
 * local-media.ts — pictures that live in the team's folder, made showable.
 *
 * 移植自 Squad 2.x packages/shared/src/local-media.ts @ 8dcb903
 * 改动：认 Windows 路径。2.x 只认以 `/` 开头的绝对路径，在 Windows 上一张图都抽不出来；
 * 这里同时认 `C:\…`、`C:/…`，分隔符 `\` 和 `/` 都算。POSIX 的行为不变（原测试原样过）。
 *
 * A pasted screenshot is written to `squad-images/`, and a seat that fetches
 * a file writes it to `squad-downloads/` (see `webAccessNote`). Both are
 * plain files on disk, and a message that mentions one has only its PATH. This
 * finds those paths so the window can show the picture where it was
 * mentioned, instead of as a line of text you will not remember the meaning of.
 *
 * Pure on purpose: the main process is what decides whether a given path may
 * actually be read.
 */

/** Folders under a team's project folder whose images the panel may show. */
export const IMAGE_DIR = "squad-images";
export const DOWNLOAD_DIR = "squad-downloads";

const DIRS = `squad-(?:images|downloads)`;
const EXT = `(?:png|jpe?g|gif|webp|bmp|svg)`;
/**
 * An absolute path's start: `/` on POSIX, `C:\` or `C:/` on Windows — and
 * `C:%5C`, which is what `markdownPath` makes of a backslash.
 */
const ABSOLUTE = `(?:\\/|[A-Za-z]:(?:[\\\\/]|%5[Cc]))`;

/** `![alt](/abs/path/x.png)` or `![alt](C:\abs\x.png)` — the main process decides whether it may be read. */
const MARKDOWN_IMAGE = new RegExp(`!\\[([^\\]]*)\\]\\((${ABSOLUTE}[^)\\s]+\\.${EXT})\\)`, "gi");

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * A path written so it survives inside `![](…)`: spaces and brackets would end
 * the link early, and a project folder with a space in it is ordinary.
 */
export function markdownPath(path: string): string {
  return encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * The file a pasted-image material points at, or undefined for any other
 * material. Reads the pointer `imagePointer` wrote, so the two must agree.
 */
export function imagePathOfMaterial(text: string): string | undefined {
  if (!text.includes("这是一张图片")) return undefined;
  const path = /文件在：(.+)/.exec(text)?.[1]?.trim();
  return path !== undefined && new RegExp(`[\\\\/]${DIRS}[\\\\/]`).test(path) ? path : undefined;
}

/**
 * Take the local pictures embedded with `![alt](/abs/x.png)` out of a message,
 * in order, so the window shows them itself; what is left is the text for the
 * Markdown renderer.
 */
export function extractLocalImages(text: string): {
  readonly text: string;
  readonly images: readonly { readonly alt: string; readonly path: string }[];
} {
  const images: { alt: string; path: string }[] = [];
  const rest = replaceOutsideCode(text, MARKDOWN_IMAGE, (_all, alt: string, path: string) => {
    images.push({ alt, path: safeDecode(path) });
    return "";
  });
  // The gap the removal leaves: a line that held only a picture is now blank.
  return {
    text: rest
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd(),
    images,
  };
}

/** A fenced block or an inline code span: text shown as written, not interpreted. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * Apply a replacement to the parts of a message that are not code.
 *
 * `![架构草图](/absolute/path/to/arch.png)` inside a code block is a
 * demonstration of the syntax, not a picture.
 */
function replaceOutsideCode(text: string, pattern: RegExp, replacement: (...groups: string[]) => string): string {
  let out = "";
  let from = 0;
  for (const code of text.matchAll(CODE)) {
    const at = code.index ?? 0;
    out += text.slice(from, at).replace(pattern, replacement as never) + code[0];
    from = at + code[0].length;
  }
  return out + text.slice(from).replace(pattern, replacement as never);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Image files a message MENTIONS, inside the team's project folder.
 *
 * Found anywhere in the text, code blocks included: an agent that finishes
 * drawing something reports the path in a fenced block so it can be copied,
 * and that is exactly the message where the picture is wanted.
 *
 * On Windows a model writes the same folder with `\` or with `/`, so the
 * folder's own separators match either.
 */
export function imagePathsIn(text: string, projectFolder: string): readonly string[] {
  const root = projectFolder.replace(/[\\/]+$/, "");
  if (root === "") return [];
  const bare = replaceOutsideCode(text, MARKDOWN_IMAGE, () => " ");
  const rootPattern = root.split(/[\\/]/).map(escapeRegExp).join("[\\\\/]");
  const found = new RegExp(`${rootPattern}[\\\\/][^\\s\`"'()<>\\]|]*?\\.${EXT}(?![\\w/\\\\.-])`, "gi");
  return [...new Set(bare.match(found) ?? [])];
}
