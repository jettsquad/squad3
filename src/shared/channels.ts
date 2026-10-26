/**
 * channels.ts — the IPC channel names, and nothing else.
 *
 * Kept apart from `wire.ts` because the preload imports them, and a sandboxed
 * preload can require `electron` and nothing more. When the names lived in
 * `wire.ts`, the preload bundle carried a `require("zod")` along with them,
 * failed to load, and the window opened blank with no `window.squad` — the
 * build was green and the only symptom was an empty page.
 *
 * This file must stay free of imports. `test/preload-imports.test.ts` holds it to that.
 */
export const INVOKE_CHANNEL = "squad:invoke";
export const EVENT_CHANNEL = "squad:event";
