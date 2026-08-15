# Real end-to-end validation checklist

This is the plain-language companion to `worker/validate_e2e.py`. That script
drives the real pipeline against real footage and reports PASS/FAIL/SKIP per
stage; this document explains what each stage actually checks, what a FAIL
means, and — critically — the handful of things that genuinely require a human
to look at a screen, because no headless script can verify them.

Do this on your own machine, not in a sandbox: you need your own `.env` (real
`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`), real `ffmpeg`, and a folder of a few real
video/audio clips.

## 1. One-time setup

Same as `worker/README.md`'s setup section:

```sh
cd worker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in your API keys
brew install ffmpeg    # if you don't already have it
```

The `export` stage runs `scripts/export-timeline.ts` directly under
`node --experimental-strip-types` (Node >= 22.6) — it has no npm dependencies
of its own, so `npm install` is not required just to run `validate_e2e.py`.
You'll still want it for everything else (`npm test`, `npm run typecheck`,
`npm run dev:desktop`):

```sh
npm install
```

## 2. Pick sample footage

3–10 real clips is enough. For a meaningful run you want at least one clip
with:

- A spoken interview/sync track (so transcription and selects have something
  real to work with — name it with `INT`/`interview` in the filename, e.g.
  `A001_INT_JORDAN_01.mov`, so the app's role-inference picks it up as
  `interview`, matching the existing filename convention).
- Some B-roll (footage with `broll`/`b-roll`/`gv` in the filename).

## 3. Run the script

```sh
cd worker
source .venv/bin/activate
python validate_e2e.py --media-root "/path/to/your/footage"
```

It prints one `[PASS]`/`[FAIL]`/`[SKIP]` line per stage as it completes, then a
summary table, then writes a full JSON report and the actual exported files to
`worker/validation-output/` (override with `--out-dir`).

Useful flags:

- `--target-seconds 60` — target length for the prompt sent to `/build`.
- `--command "..."` — the director's note passed to `/build` (default asks for
  "a short emotional story cut").
- `--analyze-timeout-seconds 1800` — raise this if you're testing with a lot of
  footage; analysis time scales with clip count/length.
- `--port` — if 32145 is already in use (e.g. the desktop app's own worker is
  running), pick a different port.

## 4. What each stage actually checks

| Stage | What PASS means | What FAIL means |
|---|---|---|
| `import_footage` | Real files were found under your media root. | Bad path, or no supported file extensions found. |
| `worker_startup` | The real `server.py` Flask app is up and answering `/health`. | Port conflict, or the app crashed on startup. |
| `analyze_run` | `POST /analyze` ran to `analysisState: "complete"`. | The pipeline errored, or didn't finish within the timeout. |
| `proxies` | Every video clip has a proxy file that `ffprobe` confirms is real, decodable H.264, ≤960px wide. | A proxy is missing, or exists but isn't actually playable. |
| `transcription` | Every clip with a real audio track (per `ffprobe`, not per filename) has a non-empty transcript. | A key is missing/wrong, the provider errored, or Whisper returned nothing. |
| `visual_analysis` | Every video clip has at least one real visual-evidence entry from the vision model. | Same causes as above, for the reasoning/vision provider. |
| `selects` | The reasoning model ranked at least one real select from the transcript/evidence. | Needs a real transcript + working reasoning provider — check the two stages above first. |
| `stories` | The reasoning model proposed at least one real story candidate. | Reasoning provider issue, or it returned nothing usable. |
| `decisions` | `POST /build` (a real prompt) returned real, non-empty, server-validated edit decisions. | The reasoning model call failed and the deterministic fallback also had nothing to assemble (no selects). |
| `preview` | For every decision, the exact file the app's `<video>` element would be given (proxy, falling back to the original) exists on disk and `ffprobe` can decode it. | A decision points at a clip with no resolvable/decodable media file. |
| `export` | The real `buildCmx3600Edl`/`buildXmeml`/`buildFcpxml` functions ran against *this run's actual decisions* (via `scripts/export-timeline.ts`, under plain `node --experimental-strip-types` — no npm dependency) and wrote real `.edl`/`.xml`/`.fcpxml` files. | Exporter threw or produced empty output. Reported as SKIP instead when Node is older than 22.6 (`--experimental-strip-types` isn't available) — install a newer Node and re-run. |

A stage reports `SKIP` (not FAIL) when an earlier stage left it with nothing to
check — e.g. `stories`/`decisions`/`preview`/`export` all SKIP if `selects` came
back empty, since there's no story to build or timeline to export. Read SKIPs
as "not exercised this run," not as "passed."

### Re-running just the export step

A full `validate_e2e.py` run writes the exact decisions it produced to
`worker/validation-output/e2e-fixture.json`. Once that file exists, you can
re-run only the export step — no worker, no API calls, no footage needed —
directly against it:

```sh
node --experimental-strip-types scripts/export-timeline.ts worker/validation-output/e2e-fixture.json worker/validation-output
```

This is the fastest way to iterate on the exporters themselves, or to
double-check the `.edl`/`.xml`/`.fcpxml` files are current before opening them
in an NLE.

## 5. What this script cannot check — do these by hand

No headless script can drive a GUI or open a third-party NLE, so these five
things are on you, once the automated stages above are green:

1. **Open the app, import the same footage, and actually scrub the preview.**
   The `preview` stage above only proves the file the player would receive is
   real and decodable — it doesn't prove playback/scrubbing feels right, that
   the playhead tracks correctly, or that switching between timeline segments
   is smooth.
2. **Play the assembled timeline in the CUT page**, not just individual clips —
   confirm segments hand off cleanly at cut points and the playhead scrubber
   overlay tracks in sync.
3. **Open the exported `.edl` in Premiere Pro, DaVinci Resolve, or Final Cut Pro
   (via `File > Import`)** and confirm it lands on the timeline with the right
   clips in the right order.
4. **Open the exported `.xml` (XMEML) in Premiere Pro** specifically — this is
   the multi-track format meant for Premiere. Confirm interview and B-roll land
   on separate video tracks as expected.
5. **Open the exported `.fcpxml` in Final Cut Pro X or DaVinci Resolve.**
   Confirm the spine assembles in order with gaps where expected. Note: FCPXML
   does not import into Premiere — that's what the `.xml`/XMEML export is for.

If any of these five manual checks fail even though `validate_e2e.py` reported
all-PASS, that's a real gap between "the code path runs and produces
well-formed output" and "a real NLE accepts it" — please report exactly what
you saw (which app, what happened on import) so it can be fixed and re-verified
against something more concrete than a structural check.

## 6. Reading the result

- **ALL PASS** — every stage that had real work to do produced real, checked
  output. Do the 5 manual checks above before calling the feature done.
- **PASS WITH SKIPS** — no failures, but some stages had nothing to check
  (e.g. your footage set had no B-roll, or no audio-only clips to skip). Not a
  failure, but re-run with footage that exercises the skipped stage before
  trusting that path.
- **FAIL** — read the FAIL line's detail text; it's written to name the actual
  cause (missing env var, empty provider response, broken file), not just
  "something went wrong."
