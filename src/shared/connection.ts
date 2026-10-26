// 移植自 Squad 2.x packages/shared/src/connection.ts @ 8dcb903
/**
 * connection.ts — what a seat runs on, and the one rule that decides how.
 *
 * Two auth modes, carried over from 1.x because they are what a person
 * actually has:
 *
 *   subscription — the human is logged into the provider's CLI on this
 *                  machine. Nothing is injected. 1.x's executor says it in
 *                  capitals: MUST NOT inject an auth token.
 *   api-key      — a credential the harness resolves per operation, with an
 *                  endpoint, which is what lets a seat point at any
 *                  compatible service rather than only the vendor's own.
 *
 * The injection rule lives HERE, in one function, with tests. It is the only
 * real difference between the two modes, and a rule about credentials that is
 * spelled out in more than one place will eventually disagree with itself —
 * in the direction where something gets sent that should not have been.
 */

export type AuthMode = "subscription" | "api-key";

/** Which CLI or channel a connection speaks through. */
export type ConnectionBackend = "claude-code" | "codex" | "dsh";

export interface SeatConnection {
  readonly connectionId: string;
  /** What a person calls it. */
  readonly displayName: string;
  readonly authMode: AuthMode;
  readonly backend: ConnectionBackend;
  readonly modelId?: string | undefined;
  /** api-key only. Empty means the backend's own default endpoint. */
  readonly endpoint?: string | undefined;
  /**
   * api-key only: the NAME of a credential, never its value.
   *
   * Resolved per operation through `ctx.credentials`, so rotating a secret
   * touches no configuration and a changed key reaches the very next turn.
   *
   * A person should almost never type this — see `credentialRefFor`. It is
   * spelled out only to reuse a secret that already exists under a known
   * name, which is the one case where inventing a fresh one would be wrong.
   */
  readonly credentialRef?: string | undefined;
  /**
   * Which header carries the key, for backends that have a choice.
   *
   * Claude Code sends `x-api-key` when it reads `ANTHROPIC_API_KEY` and
   * `Authorization: Bearer` when it reads `ANTHROPIC_AUTH_TOKEN`, and
   * gateways disagree about which they accept. MiniMax's Anthropic-compatible
   * endpoint accepts ONLY `x-api-key` — it says so even when handed a Bearer
   * — so a connection wired the other way authenticates forever and the CLI
   * retries until something times it out. Nothing in that failure mentions a
   * header.
   *
   * Absent means `x-api-key`, which is what the Anthropic API itself takes
   * and what compatible gateways overwhelmingly expect. `bearer` is there
   * because some gateways only take that, and guessing for them is how this
   * bug happened in the first place.
   */
  readonly authHeader?: "x-api-key" | "bearer" | undefined;
}

/**
 * Model namespaces each backend's own login can serve.
 *
 * The guard exists because of a specific, confusing failure 1.x hit: a
 * subscription seat given a foreign model name has that name sent to the
 * login's own endpoint, which answers with an error about the model rather
 * than about the mismatch. The person then goes looking at the model.
 */
const OWN_NAMESPACE: Readonly<Record<ConnectionBackend, readonly string[]>> = {
  "claude-code": ["claude", "sonnet", "opus", "haiku"],
  codex: ["gpt", "o1", "o3", "o4", "codex"],
  dsh: ["deepseek"],
};

/** Whether a model name is one this backend's own login can serve. */
export function isOwnModel(backend: ConnectionBackend, modelId: string): boolean {
  const name = modelId.trim().toLowerCase();
  if (name === "") return false;
  return (OWN_NAMESPACE[backend] ?? []).some((prefix) => name.startsWith(prefix));
}

/**
 * The credential name a connection gets when nobody chose one.
 *
 * A reference is an environment-variable name — dsh brands it as a POSIX
 * shell identifier — and asking a person to invent one is asking the wrong
 * question. They have a key; the name is bookkeeping, and bookkeeping the
 * system can do for itself.
 *
 * Deriving it from the connection id also keeps two connections from landing
 * on one name by accident, which would look like a key that changed itself
 * the moment the other connection was edited.
 *
 * The `SQUAD_` prefix is not decoration: it keeps a derived name out of the
 * space where a person's own exported variables live. `ctx.credentials.set`
 * REFUSES to write while a read-only source shadows the reference, so a
 * derived name that collided with an exported `ANTHROPIC_API_KEY` would make
 * pasting a key fail, with an error about shadowing that names nothing the
 * person did.
 */
export function credentialRefFor(connectionId: string): string {
  const body = connectionId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `SQUAD_${body === "" ? "CONNECTION" : body}_KEY`;
}

export interface ConnectionProblem {
  readonly detail: string;
}

/** Check a connection before it can be saved. */
export function checkConnection(connection: SeatConnection): readonly ConnectionProblem[] {
  const problems: ConnectionProblem[] = [];
  if (connection.displayName.trim() === "") problems.push({ detail: "连接要有一个名字。" });

  if (connection.authMode === "subscription") {
    // Refused rather than ignored. A stored endpoint that never takes effect
    // is a setting the person believes is in force.
    if ((connection.endpoint ?? "").trim() !== "") {
      problems.push({ detail: "订阅模式不使用自定义端点——它用的是本机 CLI 的登录态。" });
    }
    if ((connection.credentialRef ?? "").trim() !== "") {
      problems.push({ detail: "订阅模式不使用 API key。" });
    }
    const model = (connection.modelId ?? "").trim();
    if (model !== "" && !isOwnModel(connection.backend, model)) {
      problems.push({
        detail:
          `订阅模式下只能用 ${connection.backend} 自己的模型；「${model}」会被发到登录态的端点，` +
          `报出来的错会指向模型而不是这个不匹配。`,
      });
    }
  } else {
    const ref = (connection.credentialRef ?? "").trim();
    if (ref === "") {
      problems.push({
        detail:
          "API key 模式要有一个凭据名（密钥存在宿主的凭据服务里，配置里只留名字）。" +
          "界面会自己生成一个，所以看到这句话说明是直接调的接口。",
      });
    } else {
      const wrong = credentialRefProblem(ref);
      if (wrong !== undefined) problems.push({ detail: wrong });
    }
  }
  return problems;
}

/** A credential reference is an environment-variable name: a POSIX identifier. */
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why this cannot be a credential NAME, or undefined when it can. Never
 * repeats the value: what lands in this box by mistake is usually the key
 * itself (2026-10-23: a pasted key was saved as a name, and every page that
 * listed connections came up empty).
 */
export function credentialRefProblem(ref: string): string | undefined {
  if (CREDENTIAL_REF.test(ref)) return undefined;
  const looksLikeKey = ref.length >= 24 || /^(sk|pk|ak)[-_]/i.test(ref) || /[-.]/.test(ref);
  return looksLikeKey
    ? "「环境变量名」这一栏填的像是 key 本身。这里只填变量的名字（如 DEEPSEEK_API_KEY）；" +
        "要把 key 存进 Squad，取消勾选「这把 key 已经在环境变量里了」，填到 API key 框里。"
    : "凭据名只能用字母、数字和下划线，且不能以数字开头（如 DEEPSEEK_API_KEY）。";
}

/**
 * The environment one connection contributes to a seat's process.
 *
 * `credential` is the RESOLVED value, passed in rather than looked up here so
 * this stays pure and testable — the one rule that decides whether a secret
 * is sent should be the easiest thing in the system to check.
 */
interface EnvNames {
  /** Where the key goes. */
  readonly token: string;
  /** Where the endpoint goes; absent when the CLI has no such variable. */
  readonly baseUrl?: string;
  /** Where the model goes; absent when the CLI takes it on the command line. */
  readonly model?: string;
}

/**
 * The environment variables each backend actually reads.
 *
 * Per backend, because they do not agree and a single set was simply wrong
 * for two of the three: every connection used to emit `ANTHROPIC_*`, so a
 * Codex seat was handed Anthropic variables it ignores and no key it reads,
 * and it would have failed as an auth error pointing at nothing.
 *
 * Codex takes its model on the COMMAND LINE (`--model`) and has no
 * base-url variable — the CLI's own config owns the provider — so those two
 * are absent here rather than invented.
 */
const ENV_NAMES: Readonly<Record<ConnectionBackend, EnvNames>> = {
  // The token variable is decided per connection — see `authHeader`.
  "claude-code": { token: "ANTHROPIC_API_KEY", baseUrl: "ANTHROPIC_BASE_URL", model: "ANTHROPIC_MODEL" },
  codex: { token: "CODEX_API_KEY" },
  dsh: { token: "DEEPSEEK_API_KEY" },
};

/** The variable whose name decides which header Claude Code sends. */
function tokenVariable(connection: SeatConnection): string {
  if (connection.backend !== "claude-code") return ENV_NAMES[connection.backend].token;
  return connection.authHeader === "bearer" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY";
}

export function envForConnection(
  connection: SeatConnection,
  credential?: string | undefined,
): Readonly<Record<string, string>> {
  const names = ENV_NAMES[connection.backend];
  if (connection.authMode === "subscription") {
    // Nothing. Not the endpoint, not a token, and the model only when the
    // login can actually serve it AND this backend takes a model from the
    // environment at all.
    const model = (connection.modelId ?? "").trim();
    if (names.model === undefined || model === "" || !isOwnModel(connection.backend, model)) return {};
    return { [names.model]: model };
  }

  const env: Record<string, string> = {};
  const endpoint = (connection.endpoint ?? "").trim();
  if (names.baseUrl !== undefined && endpoint !== "") env[names.baseUrl] = endpoint;
  if (credential !== undefined && credential !== "") env[tokenVariable(connection)] = credential;
  const model = (connection.modelId ?? "").trim();
  // Any model name is safe here: it travels with its own endpoint and token.
  if (names.model !== undefined && model !== "") env[names.model] = model;
  return env;
}

/**
 * The model this connection wants, when the backend takes it on the command
 * line rather than from the environment.
 *
 * Returned only when it can actually be honoured: a subscription seat given a
 * foreign model has that name sent to the login's own endpoint, which answers
 * about the model rather than about the mismatch.
 */
export function modelArgumentFor(connection: SeatConnection): string | undefined {
  if (ENV_NAMES[connection.backend].model !== undefined) return undefined;
  const model = (connection.modelId ?? "").trim();
  if (model === "") return undefined;
  if (connection.authMode === "api-key") return model;
  return isOwnModel(connection.backend, model) ? model : undefined;
}

/**
 * The connection a seat should run on NOW, given the one its provider was
 * registered with.
 *
 * A provider is registered once per connection and lives until the
 * connection is deleted, so whatever it captured at registration is as old
 * as the process. Read from there, an edited model or endpoint was saved,
 * shown in the library, and ignored until the next restart — a seat went on
 * asking for the model the person had just replaced. Looked up per start,
 * the edit reaches the very next turn, the same way a rotated key already
 * did.
 *
 * Falls back to the registered copy when the lookup finds nothing: the
 * registration is about to be withdrawn, and the turn already under way
 * should fail on its own terms rather than on a missing record.
 */
export function liveConnection<T extends { readonly connectionId: string }>(
  registered: T | undefined,
  lookup: (connectionId: string) => T | undefined,
): T | undefined {
  if (registered === undefined) return undefined;
  return lookup(registered.connectionId) ?? registered;
}

/**
 * A connection as a configuration screen may see it.
 *
 * Here rather than in the library because it crosses the wall: ④ the
 * connection library builds it, the console renders it, and neither may
 * import the other.
 *
 * There is no field for the credential VALUE and there never will be. The two
 * booleans are what `ctx.credentials.describe()` answers — configured, and
 * writable-from-here — which is the whole reason a settings screen can show a
 * badge without a secret entering the browser.
 */
export interface ConnectionView extends SeatConnection {
  readonly credentialConfigured: boolean;
  readonly credentialWritable: boolean;
  /** Set when the stored credential name is malformed (its value is then withheld). */
  readonly credentialProblem?: string | undefined;
}

/**
 * Spend limits for one seat.
 *
 * Which of these can bind depends on the auth mode, and showing a limit that
 * cannot take effect is worse than showing none: it is a knob a person sets
 * and then relies on.
 */
export interface SeatCaps {
  readonly maxTurns?: number | undefined;
  readonly maxCostUsd?: number | undefined;
  readonly maxTokens?: number | undefined;
}

/**
 * Which caps mean anything under this mode.
 *
 * A subscription seat bills nothing, so a cost ceiling on it can never fire —
 * turns are what bind it. 1.x learned this and wrote it down; carrying the
 * rule means a UI can grey out the field instead of accepting a number that
 * will be ignored.
 */
export function meaningfulCaps(mode: AuthMode): readonly (keyof SeatCaps)[] {
  return mode === "subscription" ? ["maxTurns", "maxTokens"] : ["maxTurns", "maxTokens", "maxCostUsd"];
}

/** Whether a cap has been exceeded, given what a seat has used. */
export function capExceeded(
  caps: SeatCaps,
  used: { readonly turns: number; readonly tokens: number; readonly costUsd?: number | undefined },
  mode: AuthMode,
): string | undefined {
  const allowed = new Set(meaningfulCaps(mode));
  if (allowed.has("maxTurns") && caps.maxTurns !== undefined && used.turns >= caps.maxTurns) {
    return `已达轮数上限（${caps.maxTurns}）。`;
  }
  if (allowed.has("maxTokens") && caps.maxTokens !== undefined && used.tokens >= caps.maxTokens) {
    return `已达 token 上限（${caps.maxTokens}）。`;
  }
  if (
    allowed.has("maxCostUsd") &&
    caps.maxCostUsd !== undefined &&
    used.costUsd !== undefined &&
    used.costUsd >= caps.maxCostUsd
  ) {
    return `已达花费上限（$${caps.maxCostUsd}）。`;
  }
  return undefined;
}
