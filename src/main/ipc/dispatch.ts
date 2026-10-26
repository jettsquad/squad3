/**
 * dispatch.ts — every renderer call goes through here, and only here.
 *
 * Pure of Electron on purpose: the rules that matter — an unknown method is
 * refused, input is validated before any handler sees it, output is validated
 * before the renderer sees it, a thrown error comes back as its own sentence —
 * are tested without starting a window.
 */
import { methods, type MethodInput, type MethodName, type MethodOutput, type Reply } from "../../shared/wire.ts";

export type Handlers = { readonly [M in MethodName]: (input: MethodInput<M>) => Promise<MethodOutput<M>> };

function isMethodName(name: unknown): name is MethodName {
  return typeof name === "string" && Object.hasOwn(methods, name);
}

export function createDispatcher(handlers: Handlers): (method: unknown, payload: unknown) => Promise<Reply<unknown>> {
  return async (method, payload) => {
    if (!isMethodName(method)) return { ok: false, error: `没有这个方法：${String(method)}` };
    const spec = methods[method];
    const input = spec.input.safeParse(payload);
    if (!input.success) {
      // The schema's own sentences (「团队名不能是空的。」), joined — not
      // zod's JSON dump, which is for a developer, not the person at the form.
      const reasons = input.error.issues.map((issue) =>
        issue.path.length === 0 || /[一-鿿]/.test(issue.message)
          ? issue.message
          : `${issue.path.join(".")}：${issue.message}`,
      );
      return { ok: false, error: reasons.join("；") };
    }
    try {
      const handler = handlers[method] as (input: unknown) => Promise<unknown>;
      const value = await handler(input.data);
      // A handler returning the wrong shape is our bug, not the caller's. It
      // is still refused here rather than handed on: a renderer reading a
      // field that is not there fails somewhere far from the cause.
      const output = spec.output.safeParse(value);
      if (!output.success) return { ok: false, error: `「${method}」返回了不合约定的结果：${output.error.message}` };
      return { ok: true, value: output.data };
    } catch (failure) {
      return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
    }
  };
}
