// 移植自 Squad 2.x packages/console/test/notify.test.ts @ 8e96d9c
// 改动：appleScriptString 与 PresenceTracker 两组测试随函数一起去掉（3 用 Electron 的 Notification、问窗口焦点）；其余断言不变。
import { describe, expect, it } from "vitest";
import { bannerFor, previewOf, quietBanner, type FinishedRound } from "../src/main/extras/notify.ts";

const round: FinishedRound = {
  teamName: "评审组",
  kind: "round",
  stopped: false,
  answered: 2,
  failed: 0,
  last: { speaker: "架构", text: "## 结论\n**建议**采用方案 B，见 [文档](http://x)" },
  moreQueued: false,
  waitingForHost: false,
};

describe("bannerFor", () => {
  it("names the team and previews the last answer without Markdown", () => {
    const banner = bannerFor(round);
    expect(banner?.title).toBe("评审组");
    expect(banner?.body).toContain("这一轮完成了");
    expect(banner?.body).toContain("架构：结论 建议采用方案 B，见 文档");
  });
  it("stays quiet when a queued round is already starting", () => {
    expect(bannerFor({ ...round, moreQueued: true })).toBeUndefined();
  });
  it("says so when everyone failed, was stopped, or is waiting for the host", () => {
    expect(bannerFor({ ...round, failed: 2 })?.body).toContain("都没答上来");
    expect(bannerFor({ ...round, stopped: true })?.body).toContain("叫停");
    expect(bannerFor({ ...round, kind: "agenda", waitingForHost: true })?.body).toContain("等你");
  });
});

describe("previewOf", () => {
  it("truncates long replies", () => {
    expect(previewOf("字".repeat(300)).length).toBeLessThanOrEqual(91);
  });
});

describe("quietBanner", () => {
  it("names the seat and carries the reason", () => {
    const banner = quietBanner({ teamName: "评审组", seat: "甲", reason: "命令在等输入" });
    expect(banner.title).toBe("评审组");
    expect(banner.body).toContain("「甲」");
    expect(banner.body).toContain("命令在等输入");
  });
});
