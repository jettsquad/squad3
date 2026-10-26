/**
 * failure.ts — what a failed run should say when the answer itself is empty.
 *
 * 移植自 Squad 2.x packages/seat-runtime/src/index.ts 的 `failureText` @ 8dcb903（无改动）
 *
 * Every CLI writes its refusals to STDERR and its answers to stdout, and 2.x
 * once only read stdout — so a seat that failed before producing a word came
 * back as an empty reply with a red 「失败」 and nothing else. The reason was
 * sitting in a buffer already collected and never opened:
 *
 *   dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route …
 *
 * Exit code included because a CLI can also die silently, and "exited 1 with
 * no output" is still more than nothing.
 */
export function failureText(input: {
  readonly detail?: string | undefined;
  readonly stderr: string;
  readonly exitCode: number | null;
}): string {
  const parts: string[] = [];
  if (input.detail !== undefined && input.detail.trim() !== "") parts.push(input.detail.trim());
  // Trimmed here as well as at the read: a caller that passes whitespace
  // should get the exit code rather than a blank line dressed up as an
  // explanation.
  if (input.stderr.trim() !== "") parts.push(input.stderr.trim());
  if (parts.length === 0) {
    parts.push(
      input.exitCode === null
        ? "这个席位被信号杀掉了，没有任何输出。"
        : `这个席位以退出码 ${input.exitCode} 结束，stdout 和 stderr 都是空的。`,
    );
  }
  return `⚠️ 该席位没有给出答复：\n${parts.join("\n")}`;
}
