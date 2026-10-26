// 移植自 Squad 2.x packages/table/test/audit.test.ts @ 8dcb903
import { describe, expect, it } from "vitest";
import { appendAudit, AUDIT_LIMIT, type AuditEntry } from "../src/main/table/audit.ts";

const line = (n: number): AuditEntry => ({ at: n, kind: "agenda-confirmed", detail: `第 ${n} 条` });

describe("审计日志", () => {
  it("按顺序追加", () => {
    const log = appendAudit(appendAudit([], line(1)), line(2));
    expect(log.map((e) => e.detail)).toEqual(["第 1 条", "第 2 条"]);
  });

  it("不改动传进来的那份", () => {
    // 半途改掉调用方手里的数组，会让「写盘失败就当没发生」变成一句空话。
    const before: AuditEntry[] = [line(1)];
    appendAudit(before, line(2));
    expect(before).toHaveLength(1);
  });

  it("超出上限时丢掉最老的", () => {
    // 出事之后才会来看审计，而出的事是新的。
    let log: readonly AuditEntry[] = [];
    for (let i = 1; i <= AUDIT_LIMIT + 3; i++) log = appendAudit(log, line(i));
    expect(log).toHaveLength(AUDIT_LIMIT);
    expect(log[0]?.detail).toBe("第 4 条");
    expect(log[log.length - 1]?.detail).toBe(`第 ${AUDIT_LIMIT + 3} 条`);
  });

  it("带得动确认指纹", () => {
    const log = appendAudit([], { ...line(1), agendaHash: "abc123" });
    expect(log[0]?.agendaHash).toBe("abc123");
  });
});
