// 移植自 Squad 2.x packages/reasoning/src/decontextualise.ts @ 8dcb903
/**
 * decontextualise.ts — is this an abstract, or an instance wearing its coat?
 *
 * The design's own example, from a real bug:
 *
 *   NOT decontextualised (still an instance):
 *     "在 Squad 的 electron-entry.ts 里改 applyTeamConfig 时不要调
 *      teamRegistry.get()，它会触发 rehydrate 导致递归"
 *
 *   Decontextualised (now an abstract):
 *     "一个会被惰性重建路径调用的函数，内部不能再调用那条重建路径的入口
 *      —— 入口通常带着「没有就建一个」的语义。这种位置要用只读不重建的访问器。"
 *
 * The second holds for any system with lazy initialisation and has nothing to
 * do with Squad, Electron or TypeScript. That difference is the whole point,
 * and §7.4 turns it into something executable:
 *
 *   > A claim that stops holding once its context is stripped was never an
 *   > abstract — it is an instance that got mistaken for one.
 *
 * Which gives the distillation step a real test instead of asking a model
 * whether something "feels general enough".
 *
 * The line between what a machine can catch and what it cannot is drawn
 * honestly here. File paths, identifiers, URLs and names the caller supplies
 * are structural and catchable. A domain assumption buried in the phrasing is
 * not — the corrected example above still presumes lazy rebuilding exists —
 * and pretending otherwise would turn "passed the check" into a claim the
 * check cannot support.
 */

export type MarkerKind = "path" | "identifier" | "url" | "name";

export interface ContextMarker {
  readonly kind: MarkerKind;
  readonly text: string;
  readonly why: string;
}

export interface MarkerOptions {
  /**
   * Project, person and codebase names the caller knows about.
   *
   * Supplied rather than guessed: no regex knows that "Squad" is a project
   * here and an ordinary word elsewhere, and a checker that guessed would
   * either miss real names or reject sentences for containing common ones.
   */
  readonly names?: readonly string[] | undefined;
}

/** `foo/bar.ts`, `src/main.js`, `docs/a.md` — a location, not a principle. */
const PATH = /\b[\w.-]+\/[\w./-]+\.[a-z]{1,5}\b/gi;
/** A bare file name with a code-ish extension. */
const FILE = /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|md|json|ya?ml)\b/gi;
/** `applyTeamConfig()`, `registry.get()` — a specific function in a specific codebase. */
const CALL = /\b[a-z_$][\w$]*(?:\.[\w$]+)*\(\s*\)/gi;
/** `camelCaseIdentifier` and `PascalCase.member`, which name code rather than ideas. */
const IDENTIFIER = /\b(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:\.[A-Za-z][\w$]*)+)\b/g;
const URL = /\bhttps?:\/\/\S+/gi;

/**
 * Add a marker unless it is already covered.
 *
 * Covered means "part of something already reported": the file-name pattern
 * re-matches `team-store.ts` inside a path the path pattern just reported,
 * and the call pattern's identifier does the same. Reporting both is not
 * wrong so much as useless — it turns one problem into three and makes a
 * writer think there is more to fix than there is.
 */
const push = (found: ContextMarker[], seen: Set<string>, marker: ContextMarker): void => {
  const key = `${marker.kind}:${marker.text}`;
  if (seen.has(key)) return;
  if (found.some((existing) => existing.text !== marker.text && existing.text.includes(marker.text))) return;
  seen.add(key);
  found.push(marker);
};

/**
 * Everything in this text that ties it to one place.
 *
 * Reported, never stripped automatically. Rewriting someone's claim to make
 * it pass would produce a sentence they never wrote and may not agree with,
 * and the point of the check is to send it back for a real rewrite — the one
 * that finds the general principle underneath.
 */
export function findContextMarkers(text: string, options: MarkerOptions = {}): readonly ContextMarker[] {
  const found: ContextMarker[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(URL)) {
    push(found, seen, { kind: "url", text: match[0], why: "链接指向一个具体地方，别人读不到" });
  }
  for (const pattern of [PATH, FILE]) {
    for (const match of text.matchAll(pattern)) {
      push(found, seen, { kind: "path", text: match[0], why: "文件路径是某个代码库里的位置，不是原则" });
    }
  }
  for (const match of text.matchAll(CALL)) {
    push(found, seen, { kind: "identifier", text: match[0], why: "具体函数名把主张钉在一个代码库上" });
  }
  for (const match of text.matchAll(IDENTIFIER)) {
    push(found, seen, { kind: "identifier", text: match[0], why: "代码标识符命名的是实现，不是判断" });
  }
  for (const name of options.names ?? []) {
    if (name.trim() === "") continue;
    if (text.includes(name)) {
      push(found, seen, { kind: "name", text: name, why: "项目/人名让陌生人读不成立" });
    }
  }
  return found;
}

export interface AbstractnessReport {
  readonly abstract: boolean;
  readonly markers: readonly ContextMarker[];
  readonly advice: string;
}

/**
 * §7.4's executable test.
 *
 * `abstract: false` does not mean the judgement is wrong — it means what was
 * written is still the instance. The advice says so, because the useful next
 * step is to find the principle underneath, not to delete the file name and
 * call it done.
 */
export function checkAbstractness(claim: string, options: MarkerOptions = {}): AbstractnessReport {
  const markers = findContextMarkers(claim, options);
  if (markers.length === 0) {
    return {
      abstract: true,
      markers,
      advice: "机器能查的情境标记都没有了。措辞里隐含的领域假设查不了，那要靠共享池的使用反馈慢慢淘。",
    };
  }
  return {
    abstract: false,
    markers,
    advice:
      "这条还绑在具体情境上——剥掉情境就不成立的东西不是抽象，是被误当成抽象的实例。" +
      "把它下面那条一般性的原则找出来重写，而不是把名字删掉了事。",
  };
}
