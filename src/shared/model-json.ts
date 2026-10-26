// 移植自 Squad 2.x packages/shared/src/model-json.ts @ 8dcb903
/**
 * model-json.ts — getting a JSON object out of something a model said.
 *
 * Two callers ask for the same thing from opposite sides of the plugin wall:
 * ③ the secretary parsing an agenda reply, and the console parsing a team
 * plan. They had one copy between them; a second would drift, and the two
 * halves of a drifted tolerance are 「这份好好的方案被拒了」 on one screen and
 * 「这份坏方案被收了」 on the other.
 *
 * Tolerant only up to the object boundary. The failure being avoided is a
 * perfectly good answer refused because the model wrote 「给你：」 first, or
 * wrapped it in a code fence. What is INSIDE still faces a strict schema —
 * tolerance about packaging is not tolerance about content.
 */

/**
 * Parse `text` as JSON, ignoring anything around the outermost object.
 *
 * `whenMissing` is the message for a reply with no object in it at all, so
 * each caller can say which of its own jobs failed rather than emitting a
 * generic parse error nobody can place.
 */
export function extractJsonObject(text: string, whenMissing: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error(whenMissing);
    const slice = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch (error) {
      // A model writing a regular expression or a path into a JSON string
      // often leaves the backslash single (`0\.9`), which JSON refuses. The
      // intent is unambiguous, so read it as a literal backslash rather than
      // throwing the whole draft away. Only that one fault is repaired.
      const repaired = escapeStrayBackslashes(slice);
      if (repaired === slice) throw error;
      return JSON.parse(repaired);
    }
  }
}

/**
 * Double every backslash inside a JSON string that does not start a valid
 * escape. Leaves valid escapes (`\n`, `\"`, `\u00e9`) and everything
 * outside strings alone.
 */
export function escapeStrayBackslashes(json: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index] ?? "";
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inString = false;
      out += char;
      continue;
    }
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = json[index + 1] ?? "";
    const valid =
      (next !== "" && '"\\/bfnrt'.includes(next)) ||
      (next === "u" && /^[0-9a-fA-F]{4}$/.test(json.slice(index + 2, index + 6)));
    if (valid) {
      out += char + next;
      index += 1;
    } else {
      out += "\\\\";
    }
  }
  return out;
}
