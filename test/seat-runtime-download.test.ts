import { describe, expect, it } from "vitest";
// 移植自 Squad 2.x packages/seat-runtime/test/download.test.ts @ 8e96d9c
import { downloadFileName, isPrivateAddress, parseDownloadUrl } from "../src/main/seat-runtime/download.ts";
import { handleRpc } from "../src/main/seat-runtime/download-mcp.ts";

describe("isPrivateAddress", () => {
  it("refuses loopback, private, link-local and mapped addresses", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
  });
  it("allows public addresses", () => {
    for (const a of ["8.8.8.8", "198.18.1.3", "172.32.0.1", "93.184.216.34", "2606:4700::1111"])
      expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe("parseDownloadUrl", () => {
  it("only accepts https without credentials", () => {
    expect(() => parseDownloadUrl("http://a.com/x")).toThrow();
    expect(() => parseDownloadUrl("file:///etc/passwd")).toThrow();
    expect(() => parseDownloadUrl("https://u:p@a.com/x")).toThrow();
    expect(parseDownloadUrl("https://a.com/x.pdf").hostname).toBe("a.com");
  });
});

describe("downloadFileName", () => {
  const url = new URL("https://a.com/docs/sheet.pdf");
  it("cannot escape the folder", () => {
    expect(downloadFileName("../../etc/passwd", url, 1)).toBe("1-passwd");
    expect(downloadFileName(".hidden.pdf", url, 1)).toBe("1-hidden.pdf");
  });
  it("falls back to the URL's own name", () => {
    expect(downloadFileName(undefined, url, 1)).toBe("1-sheet.pdf");
  });
});

describe("handleRpc", () => {
  const ok = async () => ({ path: "/t/squad-downloads/a.pdf", bytes: 3, contentType: "application/pdf" });
  it("lists the one tool and answers initialize", async () => {
    expect(JSON.stringify(await handleRpc({ id: 1, method: "tools/list" }, ok))).toContain("download_file");
    expect(
      JSON.stringify(await handleRpc({ id: 1, method: "initialize", params: { protocolVersion: "x" } }, ok)),
    ).toContain('"x"');
  });
  it("ignores notifications", async () => {
    expect(await handleRpc({ method: "notifications/initialized" }, ok)).toBeUndefined();
  });
  it("reports a failed download as a tool error, not a protocol error", async () => {
    const bad = async () => {
      throw new Error("nope");
    };
    const out = JSON.stringify(
      await handleRpc(
        { id: 2, method: "tools/call", params: { name: "download_file", arguments: { url: "https://a.com/x" } } },
        bad,
      ),
    );
    expect(out).toContain("isError");
    expect(out).toContain("nope");
  });
});
