// 移植自 Squad 2.x packages/console/src/extract.ts @ 8dcb903
/**
 * extract.ts — turning a chosen file into text a team can read.
 *
 * Runs on the SERVER, on bytes the host explicitly picked in their own
 * browser. Nothing here executes document content: PDF and Word go through
 * dedicated parsers, everything else is decoded as UTF-8 and rejected if it
 * turns out to be binary.
 *
 * The parsers are the ones 1.x used — `pdf-parse` and `mammoth` — because the
 * job is identical and a hand-rolled docx unzipper would be a new source of
 * bugs in exchange for nothing.
 */
import { extname } from "node:path";

/** What one file turned into. */
export interface Extracted {
  readonly name: string;
  readonly text: string;
}

/** The largest file worth reading at all, in bytes. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * pdf.js reaches for a few browser drawing globals when it loads.
 *
 * We extract text and never render a page, so empty stand-ins are enough. The
 * alternative is refusing PDFs on a server, which is where this has to run:
 * the bytes arrive from the browser and the parser is a Node dependency.
 */
function ensurePdfGlobals(): void {
  const globals = globalThis as Record<string, unknown>;
  globals.DOMMatrix ??= class {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    multiply(): unknown {
      return this;
    }
    translate(): unknown {
      return this;
    }
    scale(): unknown {
      return this;
    }
  };
  globals.ImageData ??= class {};
  globals.Path2D ??= class {};
}

/** Whether this decoded text is really text. */
export function looksBinary(text: string): boolean {
  // A NUL or a replacement character means the bytes were never UTF-8. Caught
  // here rather than handed to a model as a page of mojibake.
  return text.includes("\u0000") || text.includes("\ufffd");
}

/**
 * Extract the text of one document.
 *
 * @param name - the file's own name; the extension decides the parser.
 * @param bytes - its contents.
 */
export async function extractDocument(name: string, bytes: Uint8Array): Promise<Extracted> {
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(`「${name}」有 ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限。`);
  }
  const ext = extname(name).toLowerCase();

  if (ext === ".pdf") {
    ensurePdfGlobals();
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bytes });
    try {
      const result = await parser.getText();
      return { name, text: result.text.trim() };
    } finally {
      await parser.destroy();
    }
  }

  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { name, text: result.value.trim() };
  }

  // Named, with the way out. 「不支持」 alone leaves the person guessing which
  // of the two conversions is meant.
  if (ext === ".doc") throw new Error("旧版 .doc 读不了，请另存为 .docx 或 PDF 再导入。");

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (looksBinary(text)) {
    throw new Error(`「${name}」看起来是二进制文件。支持 PDF、Word（.docx）、Markdown 和纯文本。`);
  }
  return { name, text: text.trim() };
}
