import { describe, expect, it } from "vitest";
import { createDispatcher, type Handlers } from "../src/main/ipc/dispatch.ts";

const info = { name: "Squad", version: "3.0.0-dev.0", platform: "win32", dataDir: "C:/data" };

// Only `app.info` is exercised; the other handlers are never reached.
function dispatcherWith(handler: Handlers["app.info"]): ReturnType<typeof createDispatcher> {
  return createDispatcher({ "app.info": handler } as unknown as Handlers);
}

describe("createDispatcher", () => {
  it("answers a known method with the handler's value", async () => {
    const dispatch = dispatcherWith(async () => info);
    expect(await dispatch("app.info", {})).toEqual({ ok: true, value: info });
  });

  it("refuses a method that is not in the table", async () => {
    const dispatch = dispatcherWith(async () => info);
    const reply = await dispatch("teams.delete-everything", {});
    expect(reply.ok).toBe(false);
  });

  it("refuses names inherited from Object.prototype", async () => {
    const dispatch = dispatcherWith(async () => info);
    expect((await dispatch("toString", {})).ok).toBe(false);
  });

  it("refuses input with fields the schema does not declare, before the handler runs", async () => {
    let ran = false;
    const dispatch = dispatcherWith(async () => {
      ran = true;
      return info;
    });
    const reply = await dispatch("app.info", { extra: 1 });
    expect(reply.ok).toBe(false);
    expect(ran).toBe(false);
  });

  it("carries a thrown error back as its own sentence", async () => {
    const dispatch = dispatcherWith(async () => {
      throw new Error("只能有一位秘书");
    });
    expect(await dispatch("app.info", {})).toEqual({ ok: false, error: "只能有一位秘书" });
  });

  it("refuses a handler result that breaks the contract", async () => {
    const dispatch = dispatcherWith(async () => ({ ...info, version: 3 }) as unknown as typeof info);
    expect((await dispatch("app.info", {})).ok).toBe(false);
  });
});
