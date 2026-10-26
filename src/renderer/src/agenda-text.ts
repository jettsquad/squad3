// 移植自 Squad 2.x packages/console/src/client/agenda-text.ts @ 8dcb903
/**
 * agenda-text.ts — finding an agenda inside something a seat said.
 *
 * Kept apart from the component that draws it so it can be tested without a
 * browser: the shape rules are where this goes wrong, not the markup.
 */
import { escapeStrayBackslashes } from "../../shared/model-json.ts";

export interface ReadableTask {
  readonly seatId: string;
  readonly instruction: string;
  readonly artifactPath?: string;
}

export interface ReadablePhase {
  readonly title: string;
  readonly purpose?: string;
  readonly id?: string;
  readonly needs?: readonly string[];
  readonly contextMode?: string;
  readonly exit?: string;
  readonly maxRounds?: number;
  readonly tasks: readonly ReadableTask[];
  readonly check?: { readonly command: string };
}

export interface ReadableAgenda {
  readonly hostGoal?: string;
  readonly phases: readonly ReadablePhase[];
}

export interface AgendaInText {
  /** What the seat said before the JSON. */
  readonly before: string;
  /** What it said after. */
  readonly after: string;
  readonly agenda: ReadableAgenda;
  /** The JSON as written, for the 「原始 JSON」 fold. */
  readonly json: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The end of the JSON object that starts at `start`, string-aware. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function asAgenda(value: unknown): ReadableAgenda | undefined {
  if (!isRecord(value) || !Array.isArray(value["phases"]) || value["phases"].length === 0) return undefined;
  for (const phase of value["phases"]) {
    if (!isRecord(phase) || typeof phase["title"] !== "string" || !Array.isArray(phase["tasks"])) return undefined;
    for (const task of phase["tasks"]) {
      if (!isRecord(task) || typeof task["seatId"] !== "string" || typeof task["instruction"] !== "string") {
        return undefined;
      }
    }
  }
  return value as unknown as ReadableAgenda;
}

/**
 * The agenda inside a message, if there is one.
 *
 * Found by shape (`phases` whose entries have a title and tasks), not by who
 * said it: any seat that writes one gets it shown readably. A message whose
 * JSON does not parse is left alone and shown as it always was.
 */
export function agendaInText(text: string): AgendaInText | undefined {
  if (!text.includes('"phases"') || !text.includes('"tasks"')) return undefined;
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidates: { from: number; to: number; json: string }[] = [];
  if (fenced?.[1] !== undefined && fenced.index !== undefined) {
    candidates.push({ from: fenced.index, to: fenced.index + fenced[0].length, json: fenced[1] });
  }
  const open = text.indexOf("{");
  if (open >= 0) {
    const end = objectEnd(text, open);
    if (end > open) candidates.push({ from: open, to: end, json: text.slice(open, end) });
  }
  for (const found of candidates) {
    for (const attempt of [found.json, escapeStrayBackslashes(found.json)]) {
      try {
        const agenda = asAgenda(JSON.parse(attempt));
        if (agenda !== undefined) {
          return {
            before: text.slice(0, found.from).trim(),
            after: text.slice(found.to).trim(),
            agenda,
            json: found.json,
          };
        }
      } catch {
        // Not JSON, or not this candidate: try the next, else show the text as it was.
      }
    }
  }
  return undefined;
}
