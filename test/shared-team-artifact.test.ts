// 移植自 Squad 2.x packages/shared/test/team-artifact.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import {
  ArtifactPathError,
  defaultArtifactPath,
  normaliseArtifactPath,
  resolveArtifactPath,
} from "../src/shared/team-artifact.ts";

describe("normaliseArtifactPath", () => {
  it("keeps a plain relative path", () => {
    expect(normaliseArtifactPath("docs/review.md")).toBe("docs/review.md");
  });

  it("tidies redundant segments and separators", () => {
    expect(normaliseArtifactPath("  ./docs//review.md ")).toBe("docs/review.md");
    expect(normaliseArtifactPath("docs\\review.md")).toBe("docs/review.md");
  });

  // The working directory is the user's real project folder: a path that
  // escapes it would let a discussion write anywhere on the machine.
  it("refuses to escape the project folder", () => {
    expect(() => normaliseArtifactPath("../secrets.md")).toThrow(ArtifactPathError);
    expect(() => normaliseArtifactPath("docs/../../secrets.md")).toThrow(ArtifactPathError);
  });

  it("refuses absolute paths rather than silently relocating them", () => {
    expect(() => normaliseArtifactPath("/etc/passwd")).toThrow(ArtifactPathError);
    expect(() => normaliseArtifactPath("C:\\Windows\\notes.md")).toThrow(ArtifactPathError);
  });

  it("refuses an empty path", () => {
    expect(() => normaliseArtifactPath("   ")).toThrow(ArtifactPathError);
  });
});

describe("resolveArtifactPath", () => {
  const target = { seatId: "seat-a", phaseId: "p1-host-3" };

  it("writes nothing when the host did not ask for a document", () => {
    expect(resolveArtifactPath(undefined, target, 1)).toBeUndefined();
  });

  it("uses the host's path exactly when one seat answers", () => {
    expect(resolveArtifactPath({ path: "review.md" }, target, 1)).toBe("review.md");
  });

  // One named path for several seats would leave only whoever finished last.
  it("gives each seat its own file when several answer the same instruction", () => {
    expect(resolveArtifactPath({ path: "docs/review.md" }, target, 3)).toBe("docs/review-seat-a.md");
    expect(resolveArtifactPath({ path: "review" }, target, 3)).toBe("review-seat-a");
  });

  it("falls back to a default path when the host asked for a document without naming one", () => {
    expect(resolveArtifactPath({ path: "" }, target, 1)).toBe(defaultArtifactPath(target));
    expect(defaultArtifactPath(target)).toBe("squad/seat-a-p1-host-3.md");
  });

  it("propagates a refused path instead of writing somewhere else", () => {
    expect(() => resolveArtifactPath({ path: "../outside.md" }, target, 1)).toThrow(ArtifactPathError);
  });
});
