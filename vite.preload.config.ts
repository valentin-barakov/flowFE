import { defineConfig } from "vite";

// Sandboxed preload: one CommonJS file. Only Electron stays external.
export default defineConfig({
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    lib: { entry: "src/preload/index.ts", formats: ["cjs"], fileName: () => "index.cjs" },
    rollupOptions: { external: ["electron"] },
  },
});
