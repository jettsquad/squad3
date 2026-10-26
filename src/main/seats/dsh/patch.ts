// 移植自 Squad 2.x packages/seat-dsh/src/patch.ts @ 8dcb903
/**
 * patch.ts — telling a headless DSH which model to use.
 *
 * Without this, a DSH seat runs the stock `headless` profile, which routes to
 * DeepSeek's own endpoint. A connection's endpoint and model were stored,
 * shown in the library, and then ignored — so a MiniMax key was being sent to
 * DeepSeek's API and came back 「Authentication Fails」, blaming the key for a
 * request that had gone to the wrong company.
 *
 * 1.x got this right and the mechanism is carried over: write a one-shot
 * profile patch and pass `--patch`. Two shapes, because DSH routes DeepSeek's
 * own models through a dedicated provider and everything else through the
 * OpenAI-compatible one:
 *
 *   deepseek-*  → point `llm-deepseek` at the baseURL
 *   anything else → declare one provider on `llm-pi-ai`, which the base
 *                   bundle already mounts DORMANT (no routes until a profile
 *                   supplies entries). Configuring that instance rather than
 *                   adding a second matters: a second one re-declares pi-ai's
 *                   configurable providers and the whole tree refuses to load
 *                   with 「configurable provider … is already declared」.
 *
 * The KEY never enters the file — only the name of the variable carrying it.
 * The patch is a file on disk; a secret written there would outlive the run.
 */

import { isDeepSeekModel, type ReasoningEffort } from "../../../shared/index.ts";

/**
 * The heartbeat plugin's row, by absolute path.
 *
 * An absolute path rather than a package name because the child resolves
 * names from ITS profile directory, where nothing of ours is installed —
 * measured: a `--patch` row naming a `.ts` file by absolute path loads fine,
 * which is what lets this ship without installing a profile anywhere.
 */
export function heartbeatRows(modulePath: string): readonly string[] {
  return ["- insert:", "    - id: squad-seat-heartbeat", `      name: ${JSON.stringify(modulePath)}`];
}

/**
 * The profile plugins that let a seat spawn subagents of its own.
 *
 * The headless profile mounts all of them by default: `subagent` and
 * `subagent_fork` directly, `ralph` and `workflow` by running subagents as
 * their workers, and the control tools that manage them. Read off
 * `dsh --profile headless --dump-config` (dsh 0.1.2-alpha.5), where a patch
 * row marking each `disabled: true` was checked to land on all six.
 */
export const DELEGATION_PLUGINS: readonly string[] = [
  "tool-subagent",
  "tool-subagent-fork",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-ralph",
  "tool-workflow",
];

/**
 * Patch rows turning those plugins off, for a seat not created allowing it.
 *
 * Disabled rather than left to the prompt: a fence a model is asked to
 * respect is a request, and 1.x showed what a seat does with a request when
 * it does not know the roster.
 */
export function delegationOffRows(): readonly string[] {
  return DELEGATION_PLUGINS.flatMap((id) => [`- id: ${id}`, "  disabled: true"]);
}

/** The provider id a non-DeepSeek model is routed through. */
export const COMPAT_ROUTE = "squad-compat";
/** The variable the compat provider reads its key from. */
export const COMPAT_API_KEY_ENV = "SQUAD_LLM_API_KEY";

/** Whether DSH routes this model through its own DeepSeek provider. */
export { isDeepSeekModel };

export interface PatchInput {
  /** Empty means the profile's own default model (DeepSeek's). */
  readonly model: string;
  /** Empty means the profile's own default endpoint. */
  readonly baseUrl: string;
  /**
   * The agent's thinking level, already checked against this route.
   *
   * Each route takes it differently, both measured by capturing the request:
   * `llm-deepseek.reasoningEffort` becomes `reasoning_effort` (and `off`
   * becomes `thinking: disabled`); the compat route sends NOTHING unless the
   * model declares its levels, so the patch declares them and sets the level.
   */
  readonly effort?: ReasoningEffort | undefined;
}

/** The compat-route levels a model is declared with; each key sent as spelt. */
const COMPAT_LEVELS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The patch rows for this connection, or nothing when the profile's own
 * defaults already say everything.
 */
/**
 * Whether an endpoint is DeepSeek's own public API, as opposed to a gateway.
 *
 * The bare host, with or without a trailing slash or `/v1` — the forms a
 * person types when asked for "the DeepSeek address".
 */
export function isDeepSeekPublicEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint.trim());
    return url.hostname === "api.deepseek.com" && /^\/?(v1\/?)?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function buildDshPatch(input: PatchInput): string | undefined {
  const model = input.model.trim();
  // DeepSeek's own endpoint is left for dsh to choose. Which path that is
  // belongs to the dsh version, not to the connection: 0.1.x posted to
  // `https://api.deepseek.com/chat/completions`, and 0.2 speaks the Messages
  // API from `https://api.deepseek.com/anthropic`. A connection saved with
  // the first address, handed to 0.2 as a `baseURL`, became
  // `https://api.deepseek.com/v1/messages` — and every seat on DeepSeek's own
  // model answered 「HTTP_404: DeepSeek Messages request failed」 the day dsh
  // was upgraded. A gateway's address is still passed through as given.
  const official = isDeepSeekModel(model) || model === "" ? isDeepSeekPublicEndpoint(input.baseUrl) : false;
  const baseUrl = official ? "" : input.baseUrl.trim();
  const effort = input.effort;
  if (model === "" && effort === undefined) return undefined;

  const deepseek = (): readonly string[] => {
    const config = [
      ...(baseUrl === "" ? [] : [`    baseURL: ${JSON.stringify(baseUrl)}`]),
      ...(effort === undefined ? [] : [`    reasoningEffort: ${effort}`]),
    ];
    return config.length === 0 ? [] : ["- id: llm-deepseek", "  config:", ...config];
  };

  const lines: readonly string[] =
    model === ""
      ? deepseek()
      : isDeepSeekModel(model)
        ? [
            "- id: agent-default-model",
            "  config:",
            "    provider: deepseek-official",
            `    model: ${JSON.stringify(model)}`,
            ...deepseek(),
          ]
        : [
            "- id: agent-default-model",
            "  config:",
            `    provider: ${COMPAT_ROUTE}`,
            `    model: ${JSON.stringify(model)}`,
            "- id: llm-pi-ai",
            "  config:",
            "    providers:",
            `      ${COMPAT_ROUTE}:`,
            "        displayName: Squad OpenAI-compatible",
            `        apiKeyEnv: ${COMPAT_API_KEY_ENV}`,
            "        api: openai-completions",
            `        baseURL: ${JSON.stringify(baseUrl)}`,
            ...(effort === undefined ? [] : [`        reasoning: ${effort}`]),
            "        models:",
            `          - id: ${JSON.stringify(model)}`,
            ...(effort === undefined
              ? []
              : ["            reasoningEfforts:", ...COMPAT_LEVELS.map((level) => `              ${level}: ${level}`)]),
          ];
  return `${lines.join("\n")}\n`;
}
