// Desktop-only build config. Produces a self-contained Node server bundle for the
// packaged Electron companion. The deployed web build keeps using vite.config.ts.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: { server: { entry: "server" } },
  nitro: {
    preset: "node-server",
    output: { dir: "dist-desktop" },
  },
});
