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
import { memo, useEffect, useState, type JSX, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { call } from "./api.ts";
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

function RemoteImage({
  url,
  alt,
  projectFolder,
}: {
  readonly url: string;
  readonly alt: string;
  readonly projectFolder: string | undefined;
}): JSX.Element {
  const [path, setPath] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setPath(undefined);
    setError(undefined);
    if (projectFolder !== undefined) {
      void call("images.cacheRemote", { projectFolder, url }).then(
        (result) => {
          if (!cancelled) setPath(result.path);
        },
        (reason: unknown) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [projectFolder, url, attempt]);
  return (
    <span style={{ display: "block", margin: "0.5em 0" }}>
      {path !== undefined && (
        <img
          src={mediaUrl(path)}
          alt={alt}
          style={{ maxWidth: "100%", maxHeight: 480 }}
          onError={() => setError("缓存图片加载失败。")}
        />
      )}
      {path === undefined && error === undefined && projectFolder !== undefined && (
        <span className="muted">图片加载中… </span>
      )}
      {error !== undefined && (
        <span className="muted">
          图片加载失败：{error}{" "}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            重试
          </button>{" "}
        </span>
      )}
      <a href={url} target="_blank" rel="noreferrer">
        {alt || "查看图片来源"}
      </a>
    </span>
  );
}

function isDirectImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      /\.(png|jpe?g|gif|webp|bmp)$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS: NonNullable<Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]> = [
  [rehypeHighlight, { detect: false }],
  rehypeKatex,
];
function diskPathFromHref(href: string): string | undefined {
  let path = href;
  try {
    path = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (path.startsWith("file://")) {
    try {
      path = new URL(path).pathname;
    } catch {
      return undefined;
    }
  }
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/") ? path : undefined;
}

const COMPONENTS: NonNullable<Parameters<typeof ReactMarkdown>[0]["components"]> = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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
  const [openError, setOpenError] = useState<string | undefined>(undefined);
  const { text: body, images } = extractLocalImages(text);
  const mentioned = projectFolder === undefined ? [] : imagePathsIn(body, projectFolder);
  const components: NonNullable<Parameters<typeof ReactMarkdown>[0]["components"]> = {
    ...COMPONENTS,
    img: ({ src, alt }) =>
      typeof src === "string" && /^https?:\/\//i.test(src) ? (
        <RemoteImage url={src} alt={alt ?? ""} projectFolder={projectFolder} />
      ) : (
        <span className="muted">{alt ?? "图片"}</span>
      ),
    a: ({ href, children }) => {
      if (href !== undefined && isDirectImageUrl(href) && textOf(children) === href) {
        return <RemoteImage url={href} alt="" projectFolder={projectFolder} />;
      }
      const path = href === undefined ? undefined : diskPathFromHref(href);
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (path === undefined || projectFolder === undefined) return;
            event.preventDefault();
            void call("files.open", { projectFolder, path }).then(
              () => setOpenError(undefined),
              (error: unknown) => setOpenError(error instanceof Error ? error.message : String(error)),
            );
          }}
        >
          {children}
        </a>
      );
    },
  };
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {body}
      </ReactMarkdown>
      {openError !== undefined && <div className="error">{openError}</div>}
      {[...images, ...mentioned.map((path) => ({ alt: "", path }))].map((image) => (
        <LocalImage key={image.path} path={image.path} alt={image.alt} />
      ))}
    </div>
  );
});
