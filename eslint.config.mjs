import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Module boundaries (design doc §4.1).
 *
 * 2.x kept its plugins apart by talking only through services on `ctx`. Squad 3
 * has no cordis, so the same wall is drawn here: a main-process module exports
 * one interface and one factory from its `index.ts`, and nothing reaches into
 * another module's internals. `shared` and `main/seat-runtime` are libraries,
 * not modules, and the two allowed exceptions — as they were in 2.x.
 */
const MODULES = ["table", "context", "secretary", "reasoning", "designer", "migrate", "library", "store", "vault", "seats", "extras", "ipc", "agent-check"];

export default tseslint.config(
  { ignores: ["**/node_modules/**", "out/**", "dist/**", "release/**"] },
  js.configs.recommended,
  { languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // A silent drop is this project's recurring bug family: an unused
      // binding is usually a branch that stopped doing what it says.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    // The rules of hooks, enforced rather than remembered. 2.x shipped the bug
    // they exist to catch: a `useState` after an early return, which made a
    // sidebar button do nothing. It type-checked, built and passed every test.
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // An effect's return value is its cleanup. An expression-bodied effect
      // returns whatever its call returns — and since Chromium 152
      // `scrollIntoView()` returns a Promise, which React then tried to call
      // on the next render: "destroy_ is not a function", blank window. Every
      // test passed; it took a real round in the real app to find.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name=/^use(Layout)?Effect$/] > ArrowFunctionExpression[expression=true]",
          message: "effect 要写成 `() => { ... }`：表达式写法会把调用的返回值当成清理函数交给 React。",
        },
      ],
    },
  },
  {
    // shared is pure functions and nothing else.
    files: ["src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["electron", "react", "react-dom"], message: "shared 只放纯函数，不依赖运行环境。" },
            { group: ["**/main/**", "**/renderer/**", "**/preload/**"], message: "shared 是最底层，不得依赖任何模块。" },
            { group: ["node:fs", "node:child_process", "node:net", "node:http*"], message: "shared 不做 I/O。" },
          ],
        },
      ],
    },
  },
  {
    // The renderer reaches the main process only through window.squad.
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["electron", "node:*", "**/main/**"], message: "界面只通过 window.squad 跟主进程说话。" }] },
      ],
    },
  },
  {
    // The wall between main-process modules: only `<module>/index.ts` is importable from outside it.
    files: ["src/main/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: MODULES.map((name) => ({
            group: [`**/${name}/*`, `!**/${name}/index.ts`],
            message: `模块之间只通过 ${name}/index.ts 导出的接口说话，不伸手进对方的内部文件。`,
          })),
        },
      ],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "no-restricted-imports": "off" },
  },
);
