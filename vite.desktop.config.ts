// Desktop-only build config. Produces a self-contained Node server bundle for the
// packaged Electron companion. The deployed web build keeps using vite.config.ts.
import type { Plugin } from "vite";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

/**
 * TanStack Start's route manifest records each route's absolute source path
 * (`filePath: "/Users/<you>/…/src/routes/cut.tsx"`) — build-machine
 * information that would otherwise ship inside the app. The server runtime
 * never reads `filePath`; the manifest builder only uses it to match route
 * chunks at build time. So, after bundling, absolute paths under the project
 * root are made project-relative (`src/routes/cut.tsx`) in every output chunk.
 */
function projectRelativePaths(): Plugin {
  let rootPrefix = "";
  return {
    name: "assistant-editor:project-relative-paths",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      rootPrefix = `${config.root.replace(/\/+$/, "")}/`;
    },
    renderChunk(code) {
      if (!rootPrefix || !code.includes(rootPrefix)) return null;
      return { code: code.split(rootPrefix).join(""), map: null };
    },
  };
}

export default defineConfig({
  tanstackStart: { server: { entry: "server" } },
  plugins: [projectRelativePaths()],
  // Hidden source maps: never referenced by the bundle and never packaged
  // (package.json extraResources filters *.map). scripts/acknowledgements.cjs
  // reads them to list exactly which npm packages the interface contains.
  vite: { build: { sourcemap: "hidden" } },
  nitro: {
    preset: "node-server",
    output: { dir: "dist-desktop" },
  },
});
