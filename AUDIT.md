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
