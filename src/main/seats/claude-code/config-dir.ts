// 移植自 Squad 2.x packages/seat-claude-code/src/config-dir.ts @ 8dcb903
// 改动：目录放在 Squad 自己的数据目录下（由调用方传 stateDir），不再放在 dsh 的家目录里——
// 3 不依附 dsh。规则本身没变。
/**
 * config-dir.ts — which configuration home a seat's `claude` runs against.
 *
 * Two rules, and the second one used to be wrong.
 *
 * An api-key seat must NOT use the host's: the CLI prefers a stored
 * subscription login over `ANTHROPIC_API_KEY`, so the connection's key was
 * accepted, displayed, and then ignored in favour of an OAuth token the
 * connection's gateway answered with 401.
 *
 * And the directory it uses instead must be STABLE. The CLI keeps its
 * conversations under the configuration home, so a fresh temp directory per
 * turn deleted the conversation that turn had just recorded — and the next
 * turn's `--resume` came back `No conversation found with session ID: <uuid>`.
 * Per connection is the right grain: the directory's job is to hold ONE
 * credential's state, and seats sharing a connection share a credential.
 */
import { join } from "node:path";

/**
 * @returns the directory to pass as `CLAUDE_CONFIG_DIR`, or nothing when this
 * seat should use the host's own — which is what subscription mode means.
 */
export function claudeConfigDirFor(input: {
  readonly authMode?: string | undefined;
  readonly connectionId?: string | undefined;
  /** Squad's seat-state directory. */
  readonly stateDir?: string | undefined;
}): string | undefined {
  if (input.authMode !== "api-key") return undefined;
  const id = (input.connectionId ?? "").trim();
  if (id === "") return undefined;
  return join(input.stateDir ?? "squad-seat-state", "claude-config", id);
}
