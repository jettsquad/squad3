import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Paths resolve against the repository root, where every script runs from.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // The download tool is its own process, started by a seat's CLI: a second
    // entry, so it lands beside the main bundle as out/main/download-mcp.js.
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "download-mcp": resolve("src/main/seat-runtime/download-mcp.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
        // A sandboxed preload cannot be an ES module. CommonJS, and a `.cjs`
        // name so the package's `"type": "module"` does not reinterpret it.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react()],
    build: { rollupOptions: { input: { index: resolve("src/renderer/index.html") } } },
  },
});
