# Assistant Editor AI — codebase audit

Written after taking over an existing Lovable-exported codebase and building the
missing engine/worker in the same session (see git log — there is no external
history beyond this). No GitHub connector was ever available in this working
session; this repo lives as local files (cloud sandbox + the user's machine via a
device bridge), not a live-cloned git remote. `git init` was run fresh in this pass
so the commit hash reported at the end is real and reproducible, not retrofitted.

## Correcting the brief's assumptions

The task brief assumed a larger existing system than what's actually here: named
components like "proxy generation," "semantic indexing," and a formal
"EditIntent/EditDecisionList" abstraction, and Premiere/Resolve/FCP export, do not
exist anywhere in this codebase before this session. There is no separate
"AI engine/provider abstraction" layer to inspect — the entire local engine
(`worker/`) was built from scratch in this same conversation, on top of a
Lovable-generated frontend that shipped with zero backend. This audit reflects
what's actually in the repo, not the brief's premise.

## grep results (TODO / FIXME / mock / stub / placeholder / demo / fixture / notImplemented)

Meaningful hits, filtered from UI placeholder-text noise (`placeholder="..."` on
`<input>`/`<textarea>` components is not a code stub):

- `src/lib/ae/fixtures.ts` — Demo Mode's fixture data. Real fixtures, but never
  presented as live analysis: `store.tsx` only loads them when `connection ===
  "demo"`, and never mixes them with real engine data mid-session (see
  `loadDemo()` / the boot effect's catch branch). Still, this is a fixture file
  living outside `tests/`, which conflicts with a strict "no fixtures outside
  tests" reading — flagging as a product decision (keep the onboarding/offline
  fallback vs. remove Demo Mode entirely), not fixing unilaterally.
- `premiere-uxp/src/adapter.js`, `src/lib/nle/premiere/adapter.ts` — write
  capabilities (`sequence.create`, `markers.write`, `labels.write`) explicitly
  `throw NotImplementedInHost` rather than fake success. This is the codebase
  behaving honestly about an unfinished capability, not a stub pretending to work.
- `electron/smoke-test-packaged.cjs` — comment referring to the worker's `/health`
  as "stub" predates this session's real worker; harmless, worth a comment update
  but not a functional issue.
- Everything else the grep matched (`command.tsx`, `input.tsx`, `select.tsx`,
  `textarea.tsx`, various routes) is UI placeholder text or the word "demo" in a
  connection-state label — not stubbed logic.

## What's real / production-functional right now

- **Electron shell**: window creation, IPC allowlisting (`electron/allowlist.cjs`),
  narrow desktop-capability bridge with `contextIsolation`/`sandbox` — genuinely
  security-conscious, not decorative. Confirmed launching (`npm run dev:desktop`
  loaded the app in this session, per earlier testing with the user).
- **Media ingestion + real analysis (`worker/`)**: real `ffprobe`/`ffmpeg` calls
  (duration, resolution, fps, audio extraction, frame sampling), a real FFT-based
  mains-hum detector (verified in this session against a synthetic 60Hz tone and
  a clean-noise control), real OpenAI Whisper transcription calls, real Claude
  vision calls for frame description, and real Claude calls for ranking selects,
  proposing stories, and building a timeline — all with defensive fallbacks so a
  missing key or bad model response degrades instead of crashing. I could not
  exercise the live OpenAI/Anthropic calls myself (no API keys on this side); the
  non-AI parts of the pipeline were run end-to-end against a real synthetic clip.
- **Edit decision validation (new this pass)**: `worker/pipeline.py::
  _validate_decisions` rejects any decision referencing an unknown clip, an
  unparsable timecode, an inverted in/out, or an out-point beyond the clip's real
  duration — applied to both the LLM-generated path and the deterministic
  fallback, so nothing downstream ever sees an unvalidated decision. Unit tested
  (`worker/tests/test_pipeline.py`, 9/9 passing).
- **Natural-language edit commands**: CHAT (Director Mode) is wired to
  `runCommand()` → `EngineClient.build()` → the worker's `build_timeline()`, which
  now validates its own output. Real, not simulated, when a live engine is
  attached.
- **Internal timeline model + visualization**: `UniversalTimeline`/`EditDecision`
  already exist as real types, populated from real build results; the CUT page
  renders real lanes and a real EDL-style event table from whatever the active
  version actually contains.
- **Export (new this pass)**: `src/lib/nle/edl.ts` generates a real CMX3600 EDL
  from a validated decision list, and the CUT page's export buttons now write an
  actual `.edl` file to disk via a new, narrowly-scoped `exportFile` desktop
  capability (native save dialog only — the renderer can't pass an arbitrary
  write path, same model as the existing folder picker). This is a genuine,
  if singular, working export path.

## What's still demo-only, missing, or intentionally deferred

- **Video preview/playback** — does not exist. There is no mechanism today for
  the renderer to read actual video bytes (by design: `webSecurity`/sandbox rules
  out naive `file://` access, and no local media-serving component exists yet).
  This is the single biggest gap against the requested workflow's "preview the
  edit" step. Building it correctly needs a loopback media server restricted to
  authorized roots (mirroring the existing `embedded-renderer` pattern) or a
  custom Electron protocol handler — deliberately not attempted this pass, since
  I have no way to run Electron myself to verify it, and shipping unverified
  code that touches the security boundary is exactly what "no fake buttons"
  rules out.
- **DaVinci Resolve / Final Cut Pro-specific export** — not built. The CMX3600 EDL
  export is genuinely importable by all three target applications, but it is one
  format, not three native ones. Richer, multi-track interchange (XMEML/FCPXML)
  is the natural next step and is scoped, not started.
- **Premiere UXP live bridge** — real protocol/allowlist code exists
  (`electron/premiere-bridge.cjs`, `premiere-uxp/`), but write capabilities are
  explicitly unimplemented pending validation inside a real Premiere UXP host,
  and Adobe signing/packaging was never done. This is a different mechanism from
  file-based export (live push into an already-open Premiere project) and is
  unrelated to the EDL exporter above.
- **"Semantic indexing"** — no dedicated component; the closest real equivalent is
  the transcript + visual-evidence data Claude reasons over directly. No
  embeddings/vector index exists.
- **Proxy media generation** — not implemented anywhere.
- **Metadata-only import correctly labeled, not disguised**: the desktop folder
  picker's initial index (`electron/desktop-capabilities.cjs::indexMedia`) reads
  filenames/sizes only and explicitly notes each clip as `"awaiting engine
  analysis"` (`src/lib/ae/projects.ts::clipFromMedia`) until the worker actually
  runs. This matches the brief's "no metadata-only analysis presented as footage
  understanding" rule — it's pending state, not asserted understanding.

## This session's vertical-slice status

Target: import 3–10 real clips → analyze → prompt "create a 60-second emotional
story cut" → real edit with real timecodes → preview in the standalone timeline →
export a Premiere-compatible timeline.

- Import → analyze → transcribe → visual evidence → selects → stories → build:
  code is real end-to-end; verified with a synthetic clip (ffprobe, hum
  detection, graceful no-API-key degradation, decision validation). **Not yet
  verified against real footage with real API keys** — that requires the user's
  machine and keys.
- Natural-language prompt → validated edit decisions: real, same caveat.
- "Preview it in the standalone timeline": the CUT page's real lane/EDL view
  satisfies this at the structural level (you see the actual decisions). Literal
  video scrubbing playback does not exist yet (see gap above) — do not read
  "preview" as video playback until that's built.
- Export a Premiere-compatible timeline: real, working, unit-tested CMX3600 EDL
  export, wired to a real save-file capability.

Not marking this complete — video preview and multi-NLE-native export remain, and
nothing here has been run against real footage with real API keys by anyone but
the user, who needs to do that next.

## Model-agnostic provider refactor (second pass)

Following the vertical slice above, the AI-vendor coupling was deliberately
removed. `worker/ai_client.py` (which imported and called the `openai`/`anthropic`
SDKs directly inside business-logic functions) has been deleted and replaced with:

- `worker/providers/base.py` — `TranscriptionProvider` / `ReasoningProvider`
  abstract interfaces, `TextBlock`/`ImageBlock` content primitives, `ProviderError`.
- `worker/providers/openai_provider.py` — `OpenAIWhisperTranscriptionProvider`
  (transcription — the only ASR product in this stack) and `OpenAIReasoningProvider`
  (GPT-4o), a second, independent `ReasoningProvider` implementation.
- `worker/providers/anthropic_provider.py` — `AnthropicReasoningProvider` (Claude),
  the default reasoning implementation.
- `worker/providers/registry.py` — env-var-driven provider selection
  (`ASSISTANT_EDITOR_TRANSCRIPTION_PROVIDER`, `ASSISTANT_EDITOR_REASONING_PROVIDER`).
  Unknown or unconfigured providers raise `ProviderError`, caught individually by
  transcription and reasoning so one missing key degrades only that capability.
- `worker/reasoning.py` — the vendor-agnostic editorial-reasoning architecture: every
  prompt (visual evidence, selects, stories, timeline build) and the logic that turns
  model output into validated app data. Imports no vendor SDK.
- `worker/pipeline.py` — refactored to resolve providers once per analysis run and
  thread them through with dependency-injection-friendly optional parameters, so
  tests can supply fakes directly without touching the registry, an API key, or the
  network.

Genuine proof this is a real abstraction, not an interface with one implementation
behind it: `OpenAIReasoningProvider` (GPT-4o) and `AnthropicReasoningProvider`
(Claude) both implement `ReasoningProvider` and are switchable via one env var with
no other code change. `worker/tests/fakes.py` supplies fake providers used across
`worker/tests/test_reasoning.py`, `worker/tests/test_providers.py`, and a new
`TestBuildTimelineWithInjectedProvider` suite in `worker/tests/test_pipeline.py` —
the full selects/stories/build logic runs and is asserted against in tests with zero
API keys, zero network access, and neither vendor SDK installed (confirmed: this
sandbox has neither `openai` nor `anthropic` installed, and the full suite still
passes). 28/28 tests passing (`python3 -m unittest discover -s tests -v` from
`worker/`).

What did not change: the actual editorial *content* of the prompts (verbatim,
moved from `ai_client.py` into `reasoning.py`), the `_validate_decisions` gate, and
`server.py`'s route contract. `server.py`'s startup warnings were generalized to
probe whichever provider is configured rather than hardcoding `OPENAI_API_KEY`/
`ANTHROPIC_API_KEY` checks.

Not built in this pass (noted, not hidden): no automatic fallback from one vendor
to another mid-run if the configured provider fails — a single run either uses its
configured provider or degrades that capability to "skipped," same as before. No
provider beyond the two included ships in this repo; adding one is one new file
plus one registry line, but that work itself wasn't done since no third vendor was
requested.

## Video preview, FCPXML/XMEML export, and a real local validation script (third pass)

Scoped, in order, to close the three gaps the previous pass's "still demo-only"
section named explicitly: no video preview, only one export format, and nothing
run against real footage with real API keys.

### Video preview/playback (real, new this pass)

- **Media serving**: `electron/media-protocol.cjs` registers a privileged
  `ae-media://` custom protocol (`protocol.registerSchemesAsPrivileged` +
  `protocol.handle`, wired in `electron/main.cjs`) instead of relaxing
  `webSecurity` or opening a second HTTP port. It streams real file bytes with
  full HTTP Range support (206 Partial Content, `Content-Range`) — required for
  `<video>` scrubbing, not just playback from byte zero. Every request is
  resolved through `resolveWithinRoot()`, which rejects `..` traversal
  (including mid-path), absolute paths, and embedded null bytes, and requires
  the resolved path to stay inside the project's authorized `mediaRoot` — the
  same authorization boundary `desktop-capabilities.cjs` already enforces for
  folder access, not a new one. `desktop-capabilities.cjs` gained
  `setActiveMediaRoot()`, called from `store.tsx` whenever the active project
  changes, so the protocol handler always knows the current authorized root.
- **Real proxies**: `worker/media.py::generate_proxy` transcodes every non-
  audio-only clip to a scaled (≤960px wide), H.264/AAC, faststart MP4 during
  Analyze (`worker/pipeline.py::_analyze_one_clip`), because Chromium's
  `<video>` element can't decode many camera-original formats (ProRes, MXF,
  some HEVC variants) and can't scrub a 4K master smoothly. Proxies live at
  `mediaRoot/.ae_proxies/<clipId>.mp4` — the leading dot means both the
  worker's own `walk_media_root` and the Electron folder indexer already skip
  it, so proxies never get re-ingested as source clips. A missing/failed proxy
  never fails the clip; playback falls back to the original file. 4 new real
  (ffmpeg-synthesized-clip, ffprobe-verified) tests in
  `worker/tests/test_proxy.py`.
- **Player + timeline playback**: `src/components/ae/MediaPlayer.tsx` is a real
  `<video>`-backed player (play/pause, scrub bar, time display, honest
  `MediaError`-code-to-message mapping) exposing an imperative
  `{play,pause,seek,getCurrentTime,getDuration}` handle.
  `src/lib/ae/timeline-playback.ts` is a new hook that turns a
  `UniversalTimeline`'s decisions into playable segments and drives the player
  across cut points — advancing to the next segment at a decision boundary,
  skipping segments with no resolvable source, auto-resuming playback across a
  `src` change. Wired into `watch.tsx` (single-clip preview) and `cut.tsx`
  (full timeline playback, with a draggable/clickable playhead overlay on the
  lane view).

**Verified**: the security-critical path logic (`resolveWithinRoot`,
`contentTypeFor`) was run for real (`node` — see the media-url/exporter
verification note below) against traversal attempts, absolute paths, and an
embedded null byte, all correctly rejected. All four touched `.cjs` files pass
`node --check`. `timeline-playback.ts` passes `node --experimental-strip-types`
syntax checking. **Not verified**: this sandbox has no Electron runtime and no
`node_modules`, so the actual protocol registration, a real Range request
round-trip against Chromium's `<video>` element, and the React player/hook
wiring were reviewed by hand, not executed. Running `npm run dev:desktop` on
real hardware is the next real check — `validate_e2e.py`'s `preview` stage (see
below) verifies the *precondition* (the exact file the player would receive is
real and ffprobe-decodable), which is as far as a headless script can go.

### FCPXML + XMEML export, alongside the existing CMX3600 EDL

- `src/lib/nle/timecode.ts` — timecode math (`secondsToTc`/`tcToSeconds`/
  `framesForSeconds`) extracted out of `edl.ts` so all three exporters and the
  new playback hook share one implementation instead of three copies.
- `src/lib/nle/xmeml.ts` — Premiere Pro / Final Cut Pro 7's XML sequence
  format. Real parallel `<track>` elements per lane (interview/b-roll/audio),
  frame-accurate in/out/duration from source timecodes.
- `src/lib/nle/fcpxml.ts` — Final Cut Pro X / DaVinci Resolve's format: a
  deduplicated `<resources>`/`<asset>` section referenced by id, and a single
  `<spine>` timeline with explicit `<gap>` elements filling real timing gaps
  (FCPXML requires a contiguous spine). Deliberately does not attempt FCPXML's
  connected-clip/lane anchoring for genuinely overlapping decisions — no real
  Final Cut Pro or Resolve install was available to verify that math against,
  and a wrong anchoring guess silently misplaces clips on import, which is
  worse than not supporting it. Today's pipeline never produces overlapping
  decisions; an overlap is dropped with a warning rather than guessed at. Same
  honest-scope call this codebase already made for EDL-vs-native-export in the
  previous pass.
- The CUT page's single "Export" button became three (EDL / XML / FCPXML), and
  `electron/main.cjs`'s save-dialog filters now key off the file extension.

**Verified**: 30 real assertions run via `node --experimental-strip-types`
against copies of the actual source files (Node ESM needs explicit `.ts`
extensions this project's Vite-style extensionless imports don't have, so the
copies have that one mechanical rewrite and nothing else) — timecode round-
trips, XMEML track/DOCTYPE/frame-accuracy/missing-path-warning checks, FCPXML
DOCTYPE/asset-clip/gap-frame-math/overlap-drop/asset-dedup/audio-skip checks,
and a regression check that the pre-existing EDL exporter still works after
the shared `timecode.ts` refactor. All passed, after this process caught and
fixed a real bug in the verification harness itself (a `<video>`-tag string-
slice that broke on a nested `</video>` closing tag inside a clip's own file
block) — the same bug existed in the checked-in `tests/xmeml.test.ts` and was
fixed there too. **Not verified**: an actual Premiere/Resolve/FCP import of
either format — see `VALIDATION.md`'s manual checklist.

### Local, real end-to-end validation script

`worker/validate_e2e.py`, run on your own machine with your own `.env`/
`ffmpeg`/footage, starts the real `server.py` Flask app (not a mock — the same
code the desktop app talks to) and drives it over real HTTP through every
stage: import → analyze (proxies/transcription/visual analysis) → selects →
stories → a real `/build` prompt → preview-source verification → export (runs
the actual TypeScript exporters directly, via `scripts/export-timeline.ts`
under plain Node — see the fourth-pass section below for why this replaced an
earlier `npx vitest` approach — against *this run's real decisions*, writing
real `.edl`/`.xml`/`.fcpxml` files). Each stage prints
PASS/FAIL/SKIP with the real reason, never a silent pass — see `VALIDATION.md`
for what each stage checks and the handful of things (does playback actually
scrub smoothly, does the file really import into a real NLE) no headless
script can verify.

Two real bugs were found and fixed while building this, both because it was
actually run rather than just read:

- `vitest.config.ts` never included the `@/*`-alias plugin (`vite.config.ts`'s
  own alias, from `@lovable.dev/vite-tanstack-config`, is not shared with
  Vitest — they're two separate configs) — every existing test file imports via
  `@/lib/...`, so `npm test` would have failed to resolve those imports
  entirely. Fixed by adding `vite-tsconfig-paths` (already a dependency) to
  `vitest.config.ts`.
- `werkzeug`'s `BaseWSGIServer` calls `sys.exit(1)` directly on a port-already-
  in-use error instead of letting `OSError` propagate — `validate_e2e.py`'s own
  `except OSError` around server startup didn't catch that, so a taken port
  used to kill the whole script with no report written. Fixed by also catching
  `SystemExit` there. Caught by a real subprocess test
  (`worker/tests/test_validate_e2e.py`) that binds the target port first and
  asserts a clean, reported `FAIL` rather than a crash.

`worker/tests/test_validate_e2e.py` runs the actual script as a subprocess
against real ffmpeg-synthesized footage with no API keys configured (this
sandbox has neither the `openai` nor `anthropic` SDK installed, so this also
confirms `get_transcription_provider()`/`get_reasoning_provider()` never
attempt an SDK import before the API-key check) and asserts the real, honest
result: `import_footage`/`worker_startup`/`analyze_run`/`proxies` genuinely
PASS (nothing about those needs a key), `transcription`/`visual_analysis`/
`selects` genuinely FAIL with the real cause named, and everything downstream
correctly SKIPs rather than false-passing or mis-blaming a later stage. 35/35
worker tests passing (`python3 -m unittest discover -s tests -v`), up from 32.

**Not run by me**: the AI-dependent stages (transcription, visual analysis,
selects, stories, decisions) and the actual export-file-into-a-real-NLE step —
both require the user's own API keys and, for the NLE step, a real copy of
Premiere/Resolve/FCP, neither of which exist in this sandbox. That is the one
remaining gap between "the code paths exist and this script proves the harness
itself is honest" and "this was validated against real footage with real keys"
— which is exactly the state `validate_e2e.py` and `VALIDATION.md` exist to let
the user close themselves, with a script that will tell them plainly if
something's actually broken instead of asking them to trust that it works.

## Export runner: replacing vitest-as-export-mechanism with a direct Node script (fourth pass)

`validate_e2e.py`'s `export` stage originally worked by generating a fixture
JSON of the run's real decisions, then shelling out to `npx vitest run` on a
generated test file (`tests/e2e-export.generated.test.ts`) that read the
fixture, called the real exporters, and wrote the output files. That worked,
but used a test runner as a production export mechanism — it needed
`node_modules` fully installed, depended on Vitest's CLI behaving the way a
one-off script would, and mixed "this is a test" and "this produces a real
deliverable file" in one file's purpose.

Replaced with `scripts/export-timeline.ts`, a standalone script that imports
`buildCmx3600Edl`/`buildXmeml`/`buildFcpxml`/`validateTimelineForExport` from
`src/lib/nle/` directly — the exact same functions, zero reimplementation —
and runs under plain `node --experimental-strip-types` (Node >= 22.6) with no
npm dependency at all. The one source change this required: `edl.ts`,
`xmeml.ts`, and `fcpxml.ts`'s relative runtime imports (`./timecode`,
`./xml-utils`) now carry explicit `.ts` extensions. Plain Node ESM, unlike
Vite/Vitest, never resolves extensionless relative specifiers — `tsconfig.json`
already had `allowImportingTsExtensions: true` set, so this was already a
sanctioned, typecheck-safe form, just not one anything in the codebase used
yet. Type-only imports (`import type { Clip, UniversalTimeline } from
"../ae/types"`) needed no change — they're erased entirely under
`--experimental-strip-types` and were never resolved at runtime in the first
place. `tests/e2e-export.generated.test.ts` was deleted (superseded, not kept
alongside — one export-fixture-runner, not two divergent implementations of
the same job); `worker/validate_e2e.py`'s `stage_export` now invokes
`scripts/export-timeline.ts` instead, with a `--node-bin`/version preflight
check (SKIP, not a confusing crash, on Node < 22.6) replacing the old
`node_modules`-exists check.

**Verified**: the runner was executed directly, repeatedly, in a sandbox with
zero `node_modules` and no npm registry access — proving the "no npm
dependency" claim rather than just asserting it — producing real, correct
`.edl`/`.xml`/`.fcpxml`/`export-summary.json` output from a real fixture, and
failing cleanly (clear stderr, nonzero exit, no partial output) on: missing
fixture, malformed JSON, zero decisions, and zero decisions surviving export
validation. `validate_e2e.py`'s updated `stage_export` was verified the same
way it always has been — calling it directly with synthetic project/decision
data and inspecting the resulting `Report` — confirming both the PASS path
(via the real Node runner) and the SKIP path (an unresolvable `node` binary).
The full worker suite (35/35, unchanged count — this fix touches the export
stage's *mechanism*, not the harness tests that exercise the FAIL/SKIP
cascade, which never reached the export stage without API keys) still passes.
`npm run typecheck` and `npm test` were run on the user's own machine, where
`node_modules` actually exists — this sandbox cannot run either.
