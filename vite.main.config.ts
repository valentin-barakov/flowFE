import { builtinModules } from "node:module";
import { defineConfig } from "vite";

// Electron main process: one ES module. Node built-ins, Electron, and the SDK (a native module) stay external.
export default defineConfig({
  build: {
    outDir: "dist/main",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    lib: { entry: "src/main/index.ts", formats: ["es"], fileName: () => "index.js" },
    rollupOptions: { external: ["electron", "@cursor/sdk", /^node:/, ...builtinModules] },
  },
});
