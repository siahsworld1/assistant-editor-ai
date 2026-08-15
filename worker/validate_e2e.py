#!/usr/bin/env python3
"""Real, local end-to-end validation for Assistant Editor AI.

Run this on your own machine, from the `worker/` folder, with your own `.env`
(API keys), `ffmpeg` installed, and a folder of a few real sample clips:

    source .venv/bin/activate
    python validate_e2e.py --media-root "/path/to/real/footage"

What this does — and does NOT do
---------------------------------
This starts the real worker (`server.py`'s actual Flask `app` object — the same
code the desktop app talks to) in a background thread and drives it over real
HTTP on 127.0.0.1, exactly the way the Electron app's `EngineClient` does. It is
not a mock of the pipeline; it IS the pipeline. Every stage below either PASSes
because real, checkable output exists, FAILs with the real reason, or SKIPs with
a stated reason (e.g. "no clips with audio in this footage set") — never a
silent or assumed PASS.

Stages, matching the brief this script was written to satisfy (import real
footage -> generate proxies -> transcribe -> analyze frames -> prompt -> create
real edit decisions -> preview edit -> export EDL + FCPXML/XML):

  1. import_footage  - walks your real media folder, finds real files
  2. analyze_run     - POSTs /analyze and waits for the real pipeline to finish
  3. proxies         - checks every video clip got a real, ffprobe-verified proxy
  4. transcription   - checks every audio-bearing clip got a real transcript
  5. visual_analysis - checks every video clip got real visual evidence
  6. selects         - checks the reasoning model produced ranked selects
  7. stories         - checks the reasoning model proposed story candidates
  8. decisions       - POSTs /build (a real prompt) and checks validated,
                        non-empty edit decisions came back
  9. preview         - verifies the exact media file the in-app player would be
                        given for each decision is real, on-disk, and
                        ffprobe-decodable (see "What this can't check" below)
 10. export          - runs the real TypeScript EDL/XMEML/FCPXML exporters
                        directly (scripts/export-timeline.ts, under plain
                        `node --experimental-strip-types` — no npm deps, no
                        vitest) against this run's ACTUAL decisions, and
                        writes real .edl/.xml/.fcpxml files

A later stage that has nothing to work with (e.g. decisions produced nothing)
is reported SKIP, not FAIL — the script keeps going so you get a full report
even when an early stage has a problem.

What this can't check, because no headless script can:
  - Whether the proxy actually LOOKS right when you scrub it in the app.
  - Whether the exported files import cleanly into Premiere / Resolve / DaVinci
    / Final Cut — only that they're well-formed and reference real files.
These are called out explicitly in the final report as manual follow-ups. See
VALIDATION.md for the full manual checklist.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parent
REPO_ROOT = WORKER_DIR.parent

# Run as if launched the way README.md tells you to (`python server.py` from
# worker/) regardless of the caller's actual cwd, so dotenv/.env discovery and
# any relative paths behave exactly like a normal run of the worker.
os.chdir(WORKER_DIR)

import media  # noqa: E402


# --------------------------------------------------------------------------- #
# Reporting
# --------------------------------------------------------------------------- #


@dataclass
class StageResult:
    name: str
    status: str  # PASS | FAIL | SKIP
    detail: str
    data: dict = field(default_factory=dict)


class Report:
    def __init__(self):
        self.stages: list[StageResult] = []

    def add(self, name: str, status: str, detail: str, **data) -> StageResult:
        r = StageResult(name, status, detail, data)
        self.stages.append(r)
        icon = {"PASS": "\033[32mPASS\033[0m", "FAIL": "\033[31mFAIL\033[0m", "SKIP": "\033[33mSKIP\033[0m"}[status]
        print(f"[{icon}] {name} — {detail}")
        return r

    def status_of(self, name: str) -> str | None:
        for r in self.stages:
            if r.name == name:
                return r.status
        return None

    def overall_ok(self) -> bool:
        return all(r.status != "FAIL" for r in self.stages)

    def print_summary(self):
        print("\n" + "=" * 72)
        print("SUMMARY")
        print("=" * 72)
        width = max(len(r.name) for r in self.stages)
        for r in self.stages:
            print(f"  {r.status:<5} {r.name:<{width}}  {r.detail}")
        n_pass = sum(1 for r in self.stages if r.status == "PASS")
        n_fail = sum(1 for r in self.stages if r.status == "FAIL")
        n_skip = sum(1 for r in self.stages if r.status == "SKIP")
        print("-" * 72)
        print(f"  {n_pass} PASS, {n_fail} FAIL, {n_skip} SKIP")
        if n_fail:
            print("\nRESULT: FAIL — see the FAIL lines above for what to fix.")
        elif n_skip:
            print("\nRESULT: PASS WITH SKIPS — no failures, but some stages had nothing to")
            print("check (see SKIP reasons above). Re-run with footage/config that exercises")
            print("those stages before treating this as a full pass.")
        else:
            print("\nRESULT: ALL STAGES PASSED.")
        print("\nThis script cannot verify: how the proxy looks when you actually scrub it")
        print("in the app, or whether the exported files import cleanly into Premiere /")
        print("Resolve / Final Cut. See VALIDATION.md for that manual checklist.")

    def write_json(self, path: Path):
        path.write_text(
            json.dumps(
                {
                    "stages": [
                        {"name": r.name, "status": r.status, "detail": r.detail, "data": r.data}
                        for r in self.stages
                    ],
                    "overallOk": self.overall_ok(),
                },
                indent=2,
            ),
            encoding="utf-8",
        )


# --------------------------------------------------------------------------- #
# HTTP client for the real worker
# --------------------------------------------------------------------------- #


class EngineClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def get(self, path: str, timeout: float = 30.0) -> dict:
        req = urllib.request.Request(f"{self.base_url}{path}", method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def post(self, path: str, body: dict, timeout: float = 30.0) -> dict:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}", data=data, method="POST", headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def wait_healthy(self, timeout: float = 15.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                self.get("/health", timeout=2.0)
                return True
            except (urllib.error.URLError, OSError, TimeoutError):
                time.sleep(0.25)
        return False


# --------------------------------------------------------------------------- #
# Server lifecycle (real server.py app, run in-process on a real port)
# --------------------------------------------------------------------------- #


class RunningServer:
    """Starts the real server.py Flask app via werkzeug's stoppable dev server
    (app.run() itself has no clean way to stop from another thread), and tears
    it down on exit no matter how the script finishes."""

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self._werkzeug_server = None
        self._thread = None

    def start(self):
        from werkzeug.serving import make_server

        import server as server_module  # imports the real app, runs load_dotenv()

        self.app = server_module.app
        try:
            self._werkzeug_server = make_server(self.host, self.port, self.app, threaded=True)
        except OSError as exc:
            raise RuntimeError(
                f"Could not bind {self.host}:{self.port} ({exc}). Is another copy of the worker "
                f"(or the desktop app's engine) already running? Stop it first, or pass --port."
            ) from exc
        except SystemExit as exc:
            # werkzeug's own BaseWSGIServer.__init__ prints a message and calls
            # sys.exit(1) directly on EADDRINUSE instead of letting OSError
            # propagate (see werkzeug/serving.py) — catch that too, or a taken
            # port kills this whole script with no report written at all.
            raise RuntimeError(
                f"Could not bind {self.host}:{self.port} (port already in use). Is another copy of "
                f"the worker (or the desktop app's engine) already running? Stop it first, or pass --port."
            ) from exc

        import threading

        self._thread = threading.Thread(target=self._werkzeug_server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self):
        if self._werkzeug_server is not None:
            self._werkzeug_server.shutdown()
        if self._thread is not None:
            self._thread.join(timeout=5)


# --------------------------------------------------------------------------- #
# Stage implementations
# --------------------------------------------------------------------------- #


def stage_import_footage(report: Report, media_root: str) -> list[Path]:
    root = Path(media_root).expanduser()
    if not root.exists() or not root.is_dir():
        report.add("import_footage", "FAIL", f"{media_root} does not exist or is not a directory.")
        return []
    if not media.ffmpeg_available():
        report.add(
            "import_footage", "FAIL",
            "ffmpeg/ffprobe not found on PATH. Install with `brew install ffmpeg` and try again.",
        )
        return []
    files = media.walk_media_root(media_root)
    if not files:
        report.add("import_footage", "FAIL", f"No supported media files found under {media_root}.")
        return []
    exts = sorted({f.suffix.lower() for f in files})
    report.add(
        "import_footage", "PASS",
        f"found {len(files)} real media file(s) ({', '.join(exts)}) under {media_root}",
        fileCount=len(files),
    )
    return files


def stage_analyze_run(report: Report, client: EngineClient, project_id: str, media_root: str, timeout_seconds: float) -> dict | None:
    try:
        resp = client.post("/analyze", {"projectId": project_id, "mediaRoot": media_root}, timeout=15.0)
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        report.add("analyze_run", "FAIL", f"POST /analyze failed: {exc}")
        return None
    if not resp.get("accepted"):
        report.add("analyze_run", "FAIL", f"Worker did not accept the analyze request: {resp}")
        return None

    deadline = time.time() + timeout_seconds
    last_progress = -1
    project = None
    while time.time() < deadline:
        try:
            project = client.get("/project", timeout=10.0)["project"]
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            report.add("analyze_run", "FAIL", f"GET /project failed while polling: {exc}")
            return None
        state = project.get("analysisState")
        progress = project.get("analysisProgress", 0)
        if progress != last_progress:
            print(f"    ... analyzing: {progress}% ({state})")
            last_progress = progress
        if state == "complete":
            report.add(
                "analyze_run", "PASS",
                f"analysis completed for {len(project.get('clips', []))} clip(s)",
                clipCount=len(project.get("clips", [])),
            )
            return project
        if state == "error":
            report.add("analyze_run", "FAIL", f"worker reported an analysis error: {project.get('error')}")
            return None
        time.sleep(2.0)

    report.add("analyze_run", "FAIL", f"analysis did not finish within {timeout_seconds:.0f}s (still {last_progress}%).")
    return None


def stage_proxies(report: Report, project: dict, media_root: str) -> None:
    root = Path(media_root).expanduser()
    video_clips = [c for c in project["clips"] if Path(c["filename"]).suffix.lower() not in media.AUDIO_ONLY_EXTENSIONS]
    if not video_clips:
        report.add("proxies", "SKIP", "no video clips in this footage set (audio-only) — nothing to proxy.")
        return

    missing, broken, ok = [], [], []
    for c in video_clips:
        rel = c.get("proxyRelPath") or ""
        if not rel:
            missing.append(c["filename"])
            continue
        proxy_path = root / rel
        if not proxy_path.exists():
            broken.append(f"{c['filename']} (proxy path recorded but file missing on disk)")
            continue
        info = media.ffprobe_info(proxy_path)
        width = 0
        if "x" in info.get("resolution", ""):
            try:
                width = int(info["resolution"].split("x")[0])
            except ValueError:
                width = 0
        if info["duration"] <= 0 or width <= 0 or width > media.PROXY_MAX_WIDTH:
            broken.append(f"{c['filename']} (proxy exists but ffprobe reports it as not playable/oversized)")
            continue
        ok.append(c["filename"])

    if missing or broken:
        detail = f"{len(ok)}/{len(video_clips)} clips have a real, ffprobe-verified proxy."
        if missing:
            detail += f" Missing proxy: {', '.join(missing)}."
        if broken:
            detail += f" Broken proxy: {', '.join(broken)}."
        report.add("proxies", "FAIL", detail, missing=missing, broken=broken)
    else:
        report.add("proxies", "PASS", f"all {len(ok)} video clip(s) have a real, ffprobe-verified H.264 proxy.")


def stage_transcription(report: Report, project: dict, media_root: str) -> None:
    root = Path(media_root).expanduser()
    audio_clips = []
    for c in project["clips"]:
        rel = c.get("relPath") or c["filename"]
        src = root / rel
        if src.exists() and media.ffprobe_info(src)["has_audio"]:
            audio_clips.append(c)
    if not audio_clips:
        report.add("transcription", "SKIP", "no clips with an audio track in this footage set.")
        return
    transcribed = [c for c in audio_clips if c.get("hasTranscript")]
    missing = [c["filename"] for c in audio_clips if not c.get("hasTranscript")]
    if missing:
        report.add(
            "transcription", "FAIL",
            f"{len(transcribed)}/{len(audio_clips)} audio clips got a real transcript. "
            f"No transcript for: {', '.join(missing)}. Check ASSISTANT_EDITOR_TRANSCRIPTION_PROVIDER "
            f"and OPENAI_API_KEY in your .env, and re-run.",
            missing=missing,
        )
    else:
        report.add("transcription", "PASS", f"all {len(audio_clips)} audio clip(s) got a real transcript.")


def stage_visual_analysis(report: Report, project: dict) -> None:
    video_clips = [c for c in project["clips"] if Path(c["filename"]).suffix.lower() not in media.AUDIO_ONLY_EXTENSIONS]
    if not video_clips:
        report.add("visual_analysis", "SKIP", "no video clips in this footage set.")
        return
    with_evidence = [c for c in video_clips if c.get("visualEvidenceCount", 0) > 0]
    missing = [c["filename"] for c in video_clips if c.get("visualEvidenceCount", 0) == 0]
    if missing:
        report.add(
            "visual_analysis", "FAIL",
            f"{len(with_evidence)}/{len(video_clips)} video clips got real visual evidence. "
            f"No evidence for: {', '.join(missing)}. Check ASSISTANT_EDITOR_REASONING_PROVIDER and "
            f"ANTHROPIC_API_KEY (or OPENAI_API_KEY, if configured for reasoning) in your .env.",
            missing=missing,
        )
    else:
        report.add("visual_analysis", "PASS", f"all {len(video_clips)} video clip(s) got real visual evidence.")


def stage_selects(report: Report, client: EngineClient) -> list[dict]:
    try:
        selects = client.get("/selects")["selects"]
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        report.add("selects", "FAIL", f"GET /selects failed: {exc}")
        return []
    if not selects:
        report.add(
            "selects", "FAIL",
            "no selects were ranked. Needs a real transcript and a working reasoning provider — see the "
            "transcription/visual_analysis stages above.",
        )
        return []
    report.add("selects", "PASS", f"{len(selects)} real select(s) ranked by the reasoning model.")
    return selects


def stage_stories(report: Report, client: EngineClient, selects: list[dict]) -> list[dict]:
    if not selects:
        report.add("stories", "SKIP", "no selects to build stories from.")
        return []
    try:
        stories = client.get("/stories")["stories"]
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        report.add("stories", "FAIL", f"GET /stories failed: {exc}")
        return []
    if not stories:
        report.add("stories", "FAIL", "no story candidates were proposed despite having selects.")
        return []
    report.add("stories", "PASS", f"{len(stories)} real story candidate(s) proposed by the reasoning model.")
    return stories


def stage_decisions(
    report: Report, client: EngineClient, project_id: str, stories: list[dict], target_seconds: float, command: str | None
) -> tuple[dict | None, list]:
    if not stories:
        report.add("decisions", "SKIP", "no story to build a timeline from.")
        return None, []
    story = stories[0]
    try:
        result = client.post(
            "/build",
            {"projectId": project_id, "storyId": story["id"], "targetSeconds": target_seconds, "command": command},
            timeout=60.0,
        )
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        report.add("decisions", "FAIL", f"POST /build failed: {exc}")
        return None, []
    decisions = result.get("decisions") or []
    if not decisions:
        report.add("decisions", "FAIL", f"/build returned zero edit decisions. summary: {result.get('summary')!r}")
        return None, []
    report.add(
        "decisions", "PASS",
        f"{len(decisions)} real, validated edit decision(s) created from the prompt "
        f"(story: {story['title']!r}). {result.get('summary', '')}",
        decisionCount=len(decisions),
    )
    return story, decisions


def stage_preview(report: Report, project: dict, media_root: str, decisions: list) -> None:
    if not decisions:
        report.add("preview", "SKIP", "no edit decisions to preview.")
        return
    root = Path(media_root).expanduser()
    clips_by_id = {c["id"]: c for c in project["clips"]}
    failures = []
    for d in decisions:
        clip = clips_by_id.get(d.get("clipId"))
        if not clip:
            failures.append(f"{d.get('label')}: references unknown clip {d.get('clipId')!r}")
            continue
        rel = clip.get("proxyRelPath") or clip.get("relPath")
        if not rel:
            failures.append(f"{d.get('label')}: clip {clip['filename']!r} has no relPath or proxyRelPath to preview")
            continue
        src = root / rel
        if not src.exists():
            failures.append(f"{d.get('label')}: preview source {src} does not exist on disk")
            continue
        info = media.ffprobe_info(src)
        if info["duration"] <= 0:
            failures.append(f"{d.get('label')}: preview source {src} is not ffprobe-decodable")
    if failures:
        report.add(
            "preview", "FAIL",
            f"{len(decisions) - len(failures)}/{len(decisions)} decisions resolve to a real, playable "
            f"preview source. Problems: {'; '.join(failures)}",
            failures=failures,
        )
    else:
        report.add(
            "preview", "PASS",
            f"all {len(decisions)} decisions resolve to a real, on-disk, ffprobe-decodable preview source "
            f"(the same file src the in-app <video> player would receive). Actually scrubbing it in the app "
            f"is still a manual check — see VALIDATION.md.",
        )


MIN_NODE_STRIP_TYPES_VERSION = (22, 6)


def _node_supports_strip_types(node_bin: str) -> tuple[bool, str]:
    """--experimental-strip-types needs Node >=22.6. Checked explicitly so a
    too-old Node fails this stage with a clear, actionable reason instead of a
    confusing runtime error out of the export runner itself."""
    try:
        proc = subprocess.run([node_bin, "--version"], capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.SubprocessError) as exc:
        return False, f"could not run `{node_bin} --version`: {exc}"
    version = proc.stdout.strip().lstrip("v")
    try:
        major, minor = (int(p) for p in version.split(".")[:2])
    except ValueError:
        return False, f"could not parse Node version from {version!r}"
    if (major, minor) < MIN_NODE_STRIP_TYPES_VERSION:
        return False, f"Node {version} is too old (need >= {'.'.join(map(str, MIN_NODE_STRIP_TYPES_VERSION))} for --experimental-strip-types)"
    return True, version


def build_export_fixture(project: dict, timeline_name: str, target_seconds: float, media_root: str, decisions: list) -> dict:
    """The exact { timeline, clips, mediaRoot } shape scripts/export-timeline.ts
    expects — a real UniversalTimeline built from this run's actual decisions,
    matching what the frontend's normalizeTimeline() would produce from the
    same /build response."""
    fps = 24.0
    clips = project["clips"]
    clips_by_id = {c["id"]: c for c in clips}
    if decisions and clips_by_id.get(decisions[0].get("clipId")):
        fps = clips_by_id[decisions[0]["clipId"]].get("fps") or 24.0
    total_seconds = max((d.get("timelineStartSeconds", 0) + d.get("durationSeconds", 0)) for d in decisions)

    return {
        "timeline": {
            "id": "tl-e2e-validate",
            "name": timeline_name,
            "fps": fps,
            "targetSeconds": target_seconds,
            "totalSeconds": round(total_seconds, 1),
            "decisions": decisions,
        },
        "clips": [{**c, "thumbHue": 0} for c in clips],
        "mediaRoot": media_root,
    }


def stage_export(
    report: Report, project: dict, timeline_name: str, target_seconds: float, media_root: str, decisions: list, out_dir: Path, node_bin: str,
) -> None:
    if not decisions:
        report.add("export", "SKIP", "no edit decisions to export.")
        return

    runner = REPO_ROOT / "scripts" / "export-timeline.ts"
    if not runner.exists():
        report.add("export", "FAIL", f"export runner not found: {runner}")
        return

    node_ok, node_detail = _node_supports_strip_types(node_bin)
    if not node_ok:
        report.add("export", "SKIP", f"{node_detail} — install a newer Node.js, then re-run this stage.")
        return

    out_dir.mkdir(parents=True, exist_ok=True)
    fixture = build_export_fixture(project, timeline_name, target_seconds, media_root, decisions)
    fixture_path = out_dir / "e2e-fixture.json"
    fixture_path.write_text(json.dumps(fixture, indent=2), encoding="utf-8")

    # A real Node/TypeScript process running the actual exporter functions
    # (src/lib/nle/edl.ts, xmeml.ts, fcpxml.ts) directly — no vitest, no
    # bundler, no npm dependency of any kind. See scripts/export-timeline.ts's
    # own header comment for why this replaced the earlier `npx vitest run`
    # approach.
    try:
        proc = subprocess.run(
            [node_bin, "--experimental-strip-types", str(runner), str(fixture_path), str(out_dir)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except FileNotFoundError:
        report.add("export", "SKIP", f"`{node_bin}` not found on PATH.")
        return
    except subprocess.TimeoutExpired:
        report.add("export", "FAIL", "export-timeline.ts timed out after 60s.")
        return

    if proc.returncode != 0:
        detail = (proc.stdout + proc.stderr).strip() or f"exit code {proc.returncode}, no output"
        report.add("export", "FAIL", f"export-timeline.ts failed: {detail}")
        return

    summary_path = out_dir / "export-summary.json"
    if not summary_path.exists():
        report.add("export", "FAIL", "export-timeline.ts exited 0 but export-summary.json was not written — investigate.")
        return
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    files_ok = all((out_dir / f).exists() and (out_dir / f).stat().st_size > 0 for f in summary.get("files", []))
    if not files_ok:
        report.add("export", "FAIL", f"export-timeline.ts exited 0 but expected output files are missing/empty in {out_dir}.")
        return

    warn_bits = []
    if summary.get("validationErrors"):
        warn_bits.append(f"{len(summary['validationErrors'])} decision(s) dropped by export validation")
    if summary.get("xmemlWarnings"):
        warn_bits.append(f"{len(summary['xmemlWarnings'])} XMEML warning(s)")
    if summary.get("fcpxmlWarnings"):
        warn_bits.append(f"{len(summary['fcpxmlWarnings'])} FCPXML warning(s)")
    warn_str = f" ({'; '.join(warn_bits)} — see {summary_path.name})" if warn_bits else ""

    report.add(
        "export", "PASS",
        f"wrote real {', '.join(summary['files'])} to {out_dir} from this run's actual "
        f"{summary['usableDecisions']}/{summary['decisionsInTimeline']} validated decisions{warn_str}. "
        f"Opening these in Premiere/Resolve/FCP is still a manual check — see VALIDATION.md.",
        files=summary["files"],
    )


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--media-root", required=True, help="Folder of real sample footage to run through the pipeline.")
    parser.add_argument("--project-id", default="proj-e2e-validate")
    parser.add_argument("--target-seconds", type=float, default=90.0, help="Target duration for the /build prompt.")
    parser.add_argument("--command", default="Assemble a short emotional story cut from the strongest moments.", help="Director's note passed to /build.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=32145)
    parser.add_argument("--analyze-timeout-seconds", type=float, default=1800.0)
    parser.add_argument("--out-dir", default=str(WORKER_DIR / "validation-output"))
    parser.add_argument("--node-bin", default="node", help="node binary to use for the export stage (needs Node >= 22.6).")
    args = parser.parse_args()

    out_dir = Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    report = Report()
    print(f"Assistant Editor AI — real end-to-end validation")
    print(f"media root: {args.media_root}")
    print(f"output dir: {out_dir}\n")

    files = stage_import_footage(report, args.media_root)
    if not files:
        report.print_summary()
        report.write_json(out_dir / "report.json")
        return 1

    server = RunningServer(args.host, args.port)
    try:
        server.start()
    except RuntimeError as exc:
        report.add("worker_startup", "FAIL", str(exc))
        report.print_summary()
        report.write_json(out_dir / "report.json")
        return 1

    try:
        client = EngineClient(f"http://{args.host}:{args.port}")
        if not client.wait_healthy():
            report.add("worker_startup", "FAIL", "worker did not become healthy within 15s.")
            report.print_summary()
            report.write_json(out_dir / "report.json")
            return 1
        report.add("worker_startup", "PASS", f"real worker (server.py) listening on http://{args.host}:{args.port}")

        project = stage_analyze_run(report, client, args.project_id, args.media_root, args.analyze_timeout_seconds)
        if project is not None:
            stage_proxies(report, project, args.media_root)
            stage_transcription(report, project, args.media_root)
            stage_visual_analysis(report, project)
            selects = stage_selects(report, client)
            stories = stage_stories(report, client, selects)
            story, decisions = stage_decisions(report, client, args.project_id, stories, args.target_seconds, args.command)
            stage_preview(report, project, args.media_root, decisions)
            timeline_name = f"E2E validate — {story['title']}" if story else "E2E validate"
            stage_export(report, project, timeline_name, args.target_seconds, args.media_root, decisions, out_dir, args.node_bin)
        else:
            for name in ("proxies", "transcription", "visual_analysis", "selects", "stories", "decisions", "preview", "export"):
                report.add(name, "SKIP", "analyze_run did not complete.")
    finally:
        server.stop()

    report.print_summary()
    report.write_json(out_dir / "report.json")
    print(f"\nFull JSON report: {out_dir / 'report.json'}")
    return 0 if report.overall_ok() else 1


if __name__ == "__main__":
    sys.exit(main())
