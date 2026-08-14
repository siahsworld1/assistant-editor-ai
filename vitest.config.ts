import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// vitest.config.ts is read on its own — Vitest does NOT merge it with
// vite.config.ts, so the "@/*" -> "./src/*" alias that the app's real Vite build
// gets from @lovable.dev/vite-tanstack-config's bundled tsConfigPaths plugin was
// never actually present for the test runner. Every test file under tests/
// imports via "@/lib/..." (see tests/edl.test.ts et al.), so without this plugin
// here too, `npm test` would fail to resolve those imports — a real bug, found
// while wiring up the local end-to-end validation script (worker/validate_e2e.py),
// not a hypothetical one. tsconfigPaths reads the same "@/*" mapping straight out
// of tsconfig.json, so there's exactly one place the alias is defined.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "happy-dom",
  },
});
