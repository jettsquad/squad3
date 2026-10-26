// 移植自 Squad 2.x packages/console/test/image.test.ts @ 8dcb903
/**
 * The two things about a pasted image that fail silently.
 *
 * A colliding name overwrites the previous screenshot, and the material still
 * pointing at it then shows something else entirely. A pointer that forgets
 * to say "say so if you cannot open it" produces a seat describing a picture
 * it never saw — which this project has already watched happen with
 * documents.
 */
import { describe, expect, it } from "vitest";
import { imageFileName, imagePointer, looksLikeImage } from "../src/main/extras/image.ts";

describe("looksLikeImage", () => {
  it("按扩展名认，忽略大小写", () => {
    expect(looksLikeImage("a.PNG")).toBe(true);
    expect(looksLikeImage("截图.jpeg")).toBe(true);
    expect(looksLikeImage("报告.pdf")).toBe(false);
    expect(looksLikeImage("说明.md")).toBe(false);
  });
});

describe("imageFileName", () => {
  it("同名两次不会互相覆盖——剪贴板每次都叫 image.png", () => {
    const first = imageFileName("image.png", 1);
    const second = imageFileName("image.png", 2);
    expect(first).not.toBe(second);
  });

  it("保留扩展名", () => {
    expect(imageFileName("x.webp", 1).endsWith(".webp")).toBe(true);
  });

  it("没有扩展名时当作 png", () => {
    expect(imageFileName("pasted", 1).endsWith(".png")).toBe(true);
  });

  it("路径分隔符和空白不会带进文件名", () => {
    const name = imageFileName("../../etc/pa ssword.png", 1);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name).not.toContain(" ");
  });
});

describe("imagePointer", () => {
  it("给出路径", () => {
    expect(imagePointer("/tmp/squad-images/a.png")).toContain("/tmp/squad-images/a.png");
  });

  it("要求打不开就直说，而不是猜", () => {
    const text = imagePointer("/tmp/a.png");
    expect(text).toContain("直说");
    expect(text).toContain("不要猜");
  });
});
