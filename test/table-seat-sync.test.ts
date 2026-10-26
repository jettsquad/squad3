// 移植自 Squad 2.x packages/console/test/seat-sync.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import {
  planSeatSync,
  seatMatches,
  syncSeat,
  type SyncableSeat,
  type TemplateFacts,
} from "../src/main/table/seat-sync.ts";

const template: TemplateFacts = {
  templateId: "tpl-1",
  displayName: "吴二",
  role: "架构师",
  systemPrompt: "认真作答。",
  backend: "dsh",
  connectionId: "conn-new",
  permissionMode: "acceptEdits",
};

const seat: SyncableSeat = {
  seatId: "seat-1",
  displayName: "旧名字",
  role: "旧角色",
  systemPrompt: "旧要求。",
  backend: "claude-code",
  connectionId: "conn-old",
  permissionMode: "plan",
  templateId: "tpl-1",
};

describe("把模板改动同步进席位", () => {
  it("派发相关的字段全部跟着模板走", () => {
    // 1.x 里这条注释写的就是真实故障：席位从 Claude Code 改成 DSH，团队仍然
    // 拿 `claude` 去打一个 OpenAI 兼容端点，CLI 回一句「模型有问题」——
    // 一句指向不了原因的话。
    const next = syncSeat(seat, template);
    expect(next.displayName).toBe("吴二");
    expect(next.role).toBe("架构师");
    expect(next.systemPrompt).toBe("认真作答。");
    expect(next.backend).toBe("dsh");
    expect(next.connectionId).toBe("conn-new");
    expect(next.permissionMode).toBe("acceptEdits");
  });

  it("席位自己的身份不动", () => {
    // seatId 是这张椅子在这支团队里的身份，不是 agent 的。
    expect(syncSeat({ ...seat, isSecretary: true }, template).seatId).toBe("seat-1");
    expect(syncSeat({ ...seat, isSecretary: true }, template).isSecretary).toBe(true);
  });

  it("在库里清掉连接，席位也要清掉", () => {
    // 只会「补字段」的同步永远搬不动这一步：清空的含义是「跑宿主自己的登录」。
    const next = syncSeat(seat, { ...template, connectionId: "" });
    expect(next.connectionId).toBeUndefined();
  });

  it("清掉上限也要跟着清", () => {
    const next = syncSeat({ ...seat, caps: { maxTurns: 3 } }, template);
    expect(next.caps).toBeUndefined();
  });

  it("已经一致的席位不算需要改", () => {
    expect(seatMatches(syncSeat(seat, template), template)).toBe(true);
  });

  it("只碰用了这个模板的席位", () => {
    const other: SyncableSeat = { ...seat, seatId: "seat-2", templateId: "tpl-2" };
    const plan = planSeatSync([seat, other], template);
    expect(plan.map((one) => one.seat.seatId)).toEqual(["seat-1"]);
  });

  it("没有 templateId 的席位不碰", () => {
    // 手写出来的席位没有模板，同步它等于把一个人换成另一个人。
    const handmade: SyncableSeat = { ...seat, seatId: "seat-3", templateId: undefined };
    expect(planSeatSync([handmade], template)).toEqual([]);
  });

  it("计划里带着原来的位置", () => {
    // 席位顺序就是发言顺序。重建时追加到末尾，会让「改个模型名」顺手改掉
    // 谁先说话。
    const plan = planSeatSync([{ ...seat, seatId: "seat-0", templateId: "tpl-2" }, seat], template);
    expect(plan[0]?.at).toBe(1);
  });

  it("没有变化时计划是空的", () => {
    expect(planSeatSync([syncSeat(seat, template)], template)).toEqual([]);
  });
});

describe("读取本机配置这个勾", () => {
  it("在库里取消，已经坐着的席位也跟着取消", () => {
    // 跟 webAccess 同一个坑：只会「加字段」的同步，永远传不动一次取消，
    // 于是库里显示不读、席位每轮照读——一个看起来生效了的设置。
    const sat: SyncableSeat = { ...seat, hostCustomizations: true };
    expect(syncSeat(sat, { ...template, hostCustomizations: false }).hostCustomizations).toBe(false);
    expect(seatMatches(sat, { ...template, hostCustomizations: false })).toBe(false);
  });

  it("两边都开着就不算漂移", () => {
    const sat: SyncableSeat = { ...syncSeat(seat, { ...template, hostCustomizations: true }) };
    expect(seatMatches(sat, { ...template, hostCustomizations: true })).toBe(true);
  });
});

describe("派生子 agent 这个勾", () => {
  it("在库里取消，已经坐着的席位也跟着取消", () => {
    const sat: SyncableSeat = { ...seat, subagents: true };
    expect(syncSeat(sat, { ...template, subagents: false }).subagents).toBe(false);
    expect(seatMatches(sat, { ...template, subagents: false })).toBe(false);
  });

  it("没有这个字段的旧席位算作关着，不因此被判成漂移", () => {
    const synced = syncSeat(seat, template);
    const { subagents: _dropped, ...old } = synced;
    expect(seatMatches(old, template)).toBe(true);
  });
});
