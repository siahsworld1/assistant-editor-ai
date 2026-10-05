import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// vitest.config.ts is read on its own — Vitest does NOT merge it with
// vite.config.ts, so the "@/*" -> "./src/*" alias that the app's real Vite build
// gets from @lovable.dev/vite-tanstack-config was never present for the test
// runner. Every test file under tests/ imports via "@/lib/..." (see
// tests/edl.test.ts et al.), so the alias has to be defined here too.
//
// It's an explicit alias rather than the vite-tsconfig-paths plugin on purpose:
// that plugin (v6) only applies tsconfig "paths" to files the tsconfig
// *includes*, and tsconfig.json includes src/ but not tests/ — so with the
// plugin, the edl/fcpxml/xmeml test files failed to resolve "@/lib/nle/..." and
// never ran at all, while `npm test` still reported the remaining files green.
// Keep this in sync with "paths" in tsconfig.json.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "happy-dom",
  },
});
