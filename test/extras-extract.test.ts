/**
 * What a picked file turns into. Refusals name the way out; nothing is cut short.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDocument, materialFromFile } from "../src/main/extras/index.ts";
import { imagePathOfMaterial } from "../src/shared/index.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("extractDocument", () => {
  it("reads plain text and Markdown as UTF-8", async () => {
    expect(await extractDocument("说明.md", bytes("# 标题\n正文\n"))).toEqual({
      name: "说明.md",
      text: "# 标题\n正文",
    });
  });

  it("refuses binary dressed as text, naming what it does read", async () => {
    await expect(extractDocument("x.bin", new Uint8Array([0, 1, 2, 0xff]))).rejects.toThrow(/PDF、Word/);
  });

  it("refuses the old .doc with the conversion that fixes it", async () => {
    await expect(extractDocument("旧.doc", bytes("x"))).rejects.toThrow(/另存为 \.docx/);
  });
});

describe("materialFromFile", () => {
  it("a picture becomes a file under squad-images, hidden from git, and a pointer to it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "squad-media-"));
    const material = await materialFromFile(folder, "image.png", new Uint8Array([137, 80, 78, 71]));
    const path = imagePathOfMaterial(material.text);
    expect(path).toBeDefined();
    expect(existsSync(path ?? "")).toBe(true);
    expect(readFileSync(join(folder, "squad-images", ".gitignore"), "utf8")).toContain("*");
  });
});
