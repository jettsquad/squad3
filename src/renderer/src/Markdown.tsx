/**
 * Markdown.tsx — a reply as its author wrote it: GFM tables, code with
 * highlighting and a copy button, KaTeX math, and pictures from the team's
 * folder.
 *
 * 2.x borrowed this from dsh's UI library (`MarkdownText`); 3 has its own,
 * on react-markdown. What 2.x's discussion.tsx did around it is kept:
 * pictures embedded with `![](/abs/x.png)` are pulled out and shown by the
 * window itself (`extractLocalImages`), and image paths a reply merely
 * MENTIONS inside the project are shown beneath it (`imagePathsIn`) — an agent
 * that finished a drawing reports its path in a code block, and that is the
 * message where the picture is wanted.
 *
 * No raw HTML: replies are written by models, and a reply is text to read,
 * not markup to run.
 */
import "katex/dist/katex.min.css";
import { memo, useState, type JSX, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { extractLocalImages, imagePathsIn } from "../../shared/local-media.ts";
import { t } from "./locale.ts";

/** How the window loads a picture from a team's folder; the main process decides whether it may. */
export const mediaUrl = (path: string): string => `squad-media:///${encodeURIComponent(path)}`;

/** The text inside a rendered element, for the copy button. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node !== null && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function CodeBlock({ children }: { readonly children?: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <button
        type="button"
        className="copy"
        onClick={() => {
          void navigator.clipboard.writeText(textOf(children).replace(/\n$/, "")).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? t("已复制") : t("复制")}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

/** A picture from the team's folder, or a sentence saying it could not be loaded. */
export function LocalImage({ path, alt }: { readonly path: string; readonly alt: string }): JSX.Element {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="muted">
        {t("（图片加载不出来：{path}。它可能不在团队的项目文件夹里，或者已经被删了。）", { path })}
      </div>
    );
  }
  return (
    <figure className="local-image">
      <img src={mediaUrl(path)} alt={alt} onError={() => setBroken(true)} />
      <figcaption className="muted">{alt === "" ? path : `${alt} · ${path}`}</figcaption>
    </figure>
  );
}

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]> = [
  [rehypeHighlight, { detect: false }],
  rehypeKatex,
];
const COMPONENTS: NonNullable<Parameters<typeof ReactMarkdown>[0]["components"]> = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  // Opened by the system browser (the main process routes it there);
  // the window itself never navigates away from the team.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  // A remote picture is not loaded: the window's policy allows only
  // pictures from a team's own folder. Said, not left as a blank box.
  img: ({ src, alt }) => (
    <span className="muted">
      {t("〔图片：{alt}〕", {
        alt: `${alt ?? ""}${typeof src === "string" && src !== "" ? ` · ${src}` : ""}`,
      })}
    </span>
  ),
};

/**
 * Drawn again only when its text (or folder) changes. Parsing and
 * highlighting is the costliest thing in the window, and a discussion holds
 * hundreds of these: redone on every keystroke in the box, typing lagged
 * by half a second per character (2026-10-24).
 */
export const Markdown = memo(function Markdown({
  text,
  projectFolder,
}: {
  readonly text: string;
  readonly projectFolder?: string;
}): JSX.Element {
  const { text: body, images } = extractLocalImages(text);
  const mentioned = projectFolder === undefined ? [] : imagePathsIn(body, projectFolder);
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
        {body}
      </ReactMarkdown>
      {[...images, ...mentioned.map((path) => ({ alt: "", path }))].map((image) => (
        <LocalImage key={image.path} path={image.path} alt={image.alt} />
      ))}
    </div>
  );
});
