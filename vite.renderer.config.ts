import { defineConfig } from "vite";

// The window loads these files from disk. No dev server and no remote URL.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  oxc: { jsx: { runtime: "automatic" } },
  build: { outDir: "../../dist/renderer", emptyOutDir: true, target: "chrome140" },
});
