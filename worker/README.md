# Assistant Editor AI — local worker

This is the local "engine" the desktop app talks to at `http://127.0.0.1:32145`. It is
a separate process you run alongside the app — it is not started automatically.

It does real work:

- Walks the media folder you picked in the app (Projects → Import Media).
- Extracts audio with `ffmpeg` and transcribes it with OpenAI's Whisper API.
- Detects electrical hum (50/60Hz) with real FFT analysis on the extracted audio.
- Samples frames from each video clip and asks Claude to describe what's in them
  (faces, motion, scenes, b-roll, graphics, and technical issues like soft focus).
- Asks Claude to rank the strongest moments into "selects", assemble story
  candidates from those selects, and build a timeline for a chosen story.

Speaker names are inferred from filenames that follow an `..._INT_<NAME>_...`-style
convention (matching the sample project). If your footage doesn't name speakers this
way, clips will just show "Unknown speaker" instead of failing.

## One-time setup

1. Install [ffmpeg](https://ffmpeg.org) if you don't have it:
   ```sh
   brew install ffmpeg
   ```
2. From this `worker/` folder, create a virtual environment and install dependencies:
   ```sh
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Copy `.env.example` to `.env` and fill in your API keys:
   ```sh
   cp .env.example .env
   ```
   - `OPENAI_API_KEY` — from https://platform.openai.com/api-keys (used only for Whisper transcription)
   - `ANTHROPIC_API_KEY` — from https://console.anthropic.com/settings/keys (used for vision + reasoning)

## Running

```sh
source .venv/bin/activate   # if not already active
python server.py
```

You should see:

```
Assistant Editor AI worker listening on http://127.0.0.1:32145
```

Leave this running in its own terminal tab. Then launch the app as usual
(`npm run dev:desktop` from the project root) — it polls `/health` and should switch
from "Demo Mode" to "Live" within a few seconds.

## Using it

1. In the app: **Projects → New project**, then open it.
2. **WATCH → Import media** and pick a real folder of video/audio files.
3. Click **Analyze**. This is a real pipeline (transcription + vision + reasoning per
   clip), so it takes real time — expect roughly 30-90 seconds per clip with audio,
   depending on length and how many clips you have. Progress updates live via the
   Projects panel while it runs.
4. Once complete, **Selects** and **Stories** populate from real analysis. Building a
   timeline from a chosen story also calls Claude to assemble the cut.

## Costs

Every Analyze run makes real API calls: one Whisper transcription per clip with audio,
one Claude vision call per clip, and one Claude call each for selects/stories/build.
Costs scale with clip count and length — for a handful of short test clips this is
cents, not dollars, but a full documentary's worth of raw interview footage will add
up. Check your usage on the OpenAI and Anthropic dashboards if you're unsure.

## Known limitations

- No true speaker diarization — one speaker per clip, inferred from the filename.
- Soft focus / rolling shutter / exposure issues are Claude's read on sampled frames,
  not a calibrated computer-vision measurement — treat them as a first pass, not a QC
  report.
- No persistence: state lives in memory while `server.py` runs. Restarting the worker
  clears everything; re-run Analyze after a restart.
- `/nle` (Premiere/FCP/Resolve detection) is not implemented here — Premiere
  integration is handled by a separate bridge already in the desktop app
  (`electron/premiere-bridge.cjs`), unrelated to this worker.
