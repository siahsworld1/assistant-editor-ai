# Welcome to your Lovable project

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS

## Desktop Companion

The Assistant Editor UI ships as a web renderer plus a thin Electron shell. The
shell exists for one reason: browsers block `https://` pages from calling
`http://127.0.0.1:32145` (mixed content / CORS / private network access). Inside
the desktop companion, the renderer talks to the local worker through a narrow
IPC bridge instead.

### Development commands

```sh
npm run dev:web        # renderer only, http://localhost:8080 (DirectLoopbackTransport)
npm run dev:desktop    # renderer + Electron shell (DesktopBridgeTransport)
npm run desktop:start  # Electron only, against an already-running Vite renderer
npm run typecheck      # full TypeScript check
```

In development the shell loads `ASSISTANT_EDITOR_RENDERER_URL`
(default `http://localhost:8080`).

### Production renderer (no Vite required)

Packaged builds do **not** need the Vite dev server. `vite.desktop.config.ts`
produces a TanStack Start **node-server** bundle in `dist-desktop/`, which
electron-builder copies into the app as `resources/renderer`. On launch, when
`app.isPackaged` is true, the main process:

1. picks a free loopback port (dynamically assigned, never fixed to 8080),
2. spawns `resources/renderer/server/index.mjs` as a child process using
   Electron's own binary in Node mode (`ELECTRON_RUN_AS_NODE=1`, `shell: false`),
3. polls `http://127.0.0.1:<port>` until it answers (30s timeout),
4. only then creates the BrowserWindow and locks navigation to that origin.

All routes and SSR behave exactly as on the web; nothing is loaded over `file://`.
If startup fails, a styled error window appears with **Retry** and **Quit**. The
child process is killed on window teardown, `before-quit`, `quit` and process exit.

Exercise the production path locally without packaging:

```sh
npm run desktop:prepare      # builds dist-desktop
npm run desktop:start:prod   # Electron with the embedded renderer
```

### Production build and packaging

```sh
npm run desktop:prepare     # 1. build the renderer bundle (dist-desktop/)
npm run desktop:pack        # prepare + unpacked app in release/
npm run desktop:build:mac   # prepare + dmg/zip (unsigned, identity: null)
npm run desktop:build:win   # prepare + nsis/zip (unsigned)
```

Each packaging script runs the renderer build first, so `release/` output is
self-contained. Only `electron/**` (minus smoke tests) plus `dist-desktop/`
are packaged — no source, screenshots, `.env` files or dev tooling.

### Pointing at the worker

Run the Assistant Editor local worker so it listens on `127.0.0.1:32145`. That
origin is hard-coded in `electron/allowlist.cjs` and is the only host the bridge
will ever contact. Health is polled every ~10s; a failed poll shows
Degraded / Reconnecting and never silently drops to Demo Mode.

### How the bridge works

- `electron/preload.cjs` exposes exactly one object, `window.assistantEditorBridge`,
  with a single `request({ method, path, body?, headers?, timeoutMs? })` function.
- `electron/main.cjs` handles the `assistant-editor:request` IPC channel, validates
  the request against the allowlist, proxies it to the worker with a timeout
  (default 8s, max 60s) and returns `{ status, body, error? }`.
- The renderer's `DesktopBridgeTransport` (`src/lib/ae/transport.ts`) is preferred
  whenever the bridge is present; otherwise `DirectLoopbackTransport` is used on
  localhost, and hosted HTTPS origins report "Desktop Bridge Required".
- Types live in `src/types/bridge.d.ts` — no `any`-typed bridge calls.

### Security boundaries

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`.
- Only these routes are proxied: `GET /health`, `GET /selects`, `GET /stories`,
  `GET /project` (optional), `GET /nle` (optional), `POST /analyze`, `POST /build`.
  Everything else — absolute URLs, other hosts, `file://`, path traversal, other
  HTTP methods — is rejected in the main process.
- Request headers are stripped to a fixed safe set; no shell execution, no
  filesystem access and no arbitrary network access is exposed to the renderer.
- Navigation is restricted to the renderer origin; `window.open` is denied and
  external links open in the system browser. DevTools are enabled in development only.
- No Premiere / Final Cut / Resolve integration code runs in Electron; the bridge
  only transports the engine API.

### Smoke test

```sh
npx electron electron/smoke-test.cjs            # bridge/allowlist, dev renderer + worker on 32145
npx electron electron/smoke-test-packaged.cjs   # production path: embedded renderer + bridge
```

### Signing

Signing/notarization credentials are intentionally not configured; macOS builds
must be packaged on macOS and Windows builds on Windows for native targets.

### Local project workflow (desktop)

The desktop companion adds a narrow, user-gated capability channel on top of the
engine bridge: `window.assistantEditorDesktop`.

| Capability | Behaviour |
| --- | --- |
| `listProjects` / `saveProject` / `deleteProject` | Project metadata persisted to `userData/projects.json` (name, client, format, profile, media root, media count). |
| `chooseMediaFolder` | Opens the native folder picker. The chosen path — and only that path — is added to the session allowlist. |
| `indexMedia(path)` | Metadata-only walk of an authorised folder (extension filter, hidden dirs skipped, no symlink escape, depth/file caps). No video is decoded or uploaded. |

Security boundaries: the renderer cannot pass an arbitrary path. Any path that was
not returned by the native picker in this session is rejected, `..` segments and
relative paths are rejected, and unknown action names are rejected before any
filesystem call. Media import is unavailable in a plain browser tab by design —
WATCH explains this instead of pretending to index.

Typical flow: **Projects → New project** → open it → **WATCH → Import media** →
**Analyze** (runs on the local worker at `http://127.0.0.1:32145`). In the browser,
project metadata falls back to `localStorage` for development; Demo Mode remains an
explicit, labelled fallback and is never mixed into a Live Engine session.

### Tests

```bash
npm run typecheck
npm test                                        # project persistence + capability boundary units
npx electron electron/smoke-test.cjs            # bridge/allowlist + desktop capability IPC
npx electron electron/smoke-test-packaged.cjs   # embedded production renderer
```

## Premiere Pro Integration (v0.4.0)

Adobe Premiere Pro support ships as a **UXP** panel (not CEP) under
`premiere-uxp/`, plus a loopback contract server inside the desktop companion.

```
Premiere Pro (UXP panel)  --http-->  127.0.0.1:32146  (desktop companion)
                                          |
                                          +--> Assistant Editor worker 127.0.0.1:32145
```

### Layout

| Path | Role |
| --- | --- |
| `premiere-uxp/manifest.json` | UXP manifest (`manifestVersion: 5`, single allowed network domain) |
| `premiere-uxp/index.html`, `src/panel.{js,css}` | Compact premium panel matching the Assistant Editor system |
| `premiere-uxp/src/adapter.js` | Premiere host adapter (real calls only; unverified APIs are capability-false stubs) |
| `premiere-uxp/src/bridge-client.js` | Three-path loopback client |
| `electron/premiere-protocol.cjs` | Message/command validation, version handshake, edit-decision mapping |
| `electron/premiere-bridge.cjs` | Loopback contract server on `127.0.0.1:32146` |
| `src/lib/nle/premiere/*` | Typed contract, adapter interface, renderer status hook |

### Commands

```sh
npm run premiere:prepare   # build dist-premiere/ai.assistanteditor.premiere (unsigned package dir)
npm run dev:desktop        # desktop companion + Premiere bridge on :32146
npm test                   # includes premiere-contract + premiere-bridge suites
```

Load in Premiere with Adobe's UXP Developer Tool — see `premiere-uxp/README.md`.

### Security boundaries

- Only three bridge routes exist: `GET /premiere/health`, `GET /premiere/commands`,
  `POST /premiere/message`. Everything else returns 404/405.
- Loopback-bound only; browser origins (`https://…`, `http://localhost:8080`) are
  rejected with 403. Only UXP-style (`app://`, `plugin://`) or origin-less callers pass.
- 64 KB message cap, strict per-type payload validation, allowlisted capability
  keys, allowlisted desktop→plugin commands. No filesystem, shell or arbitrary
  URL access is reachable from the panel or the renderer.
- The Electron renderer's existing bridge, allowlist and worker origin
  (`127.0.0.1:32145`) are unchanged.

### Non-destructive by default

Builds never touch the editor's active sequence. `nextVersionedSequenceName()`
produces collision-free names like `Community Doc — AE Selects v001`, and every
mapped plan starts with a `createSequence` op carrying `replacesActiveSequence: false`.

### Still required for distribution

Adobe code signing, `.ccx` bundling via Adobe's UXP packager, Marketplace review,
and folding `dist-premiere/` into the macOS/Windows installer. **None of these are
done** — the current output is an unsigned package directory for UDT loading.
Write capabilities (`sequence.create`, `clip.insert`, `broll.insert`,
`markers.write`, `labels.write`) are reported `false` until validated inside a
real Premiere UXP host.
