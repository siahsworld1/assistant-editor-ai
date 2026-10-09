"""Assistant Editor AI — local engine/worker.

Listens on 127.0.0.1:32145 (matching src/lib/ae/transport.ts::ENGINE_BASE_URL and
electron/allowlist.cjs::ENGINE_ORIGIN) and implements the contract the app's
EngineClient (src/lib/ae/service.ts) expects: /health, /analyze, /selects, /stories,
/build, /project, /nle.

Run: `python server.py` (see README.md for setup).
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path

from dotenv import load_dotenv

# ASSISTANT_EDITOR_SKIP_DOTENV=1 is set by the automated test suite (see
# worker/tests/_no_real_credentials.py). Without it, load_dotenv() searches up
# from worker/ and finds the repo-root .env, silently restoring real API keys a
# test had deliberately removed — which is how "no API keys" tests ended up
# making real, paid provider calls.
if os.environ.get("ASSISTANT_EDITOR_SKIP_DOTENV") != "1":
    load_dotenv()

from flask import Flask, jsonify, request  # noqa: E402 - load_dotenv must run first

import director  # noqa: E402
import story  # noqa: E402
import coverage_rank  # noqa: E402
import media  # noqa: E402
import persistence  # noqa: E402
import pipeline  # noqa: E402
from store import STORE  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("assistant-editor-worker")

HOST = "127.0.0.1"
PORT = 32145

app = Flask(__name__)

_analysis_lock = threading.Lock()


@app.after_request
def add_cors(resp):
    # Only used by `npm run dev:web` (plain browser tab hitting loopback directly);
    # the packaged desktop app proxies through Electron's main process instead.
    resp.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*")
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "content-type, x-assistant-editor-client"
    return resp


@app.route("/health", methods=["GET"])
def health():
    return jsonify(STORE.health_json())


@app.route("/analyze", methods=["POST", "OPTIONS"])
def analyze():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    project_id = body.get("projectId") or body.get("project")
    media_root = body.get("mediaRoot") or body.get("path")

    if not _analysis_lock.acquire(blocking=False):
        return jsonify({"accepted": False, "state": STORE.analysis_state, "progress": STORE.analysis_progress})

    def run():
        try:
            pipeline.run_analysis(project_id, media_root)
        finally:
            _analysis_lock.release()

    threading.Thread(target=run, daemon=True).start()
    return jsonify({"accepted": True, "state": "running", "progress": STORE.analysis_progress or 2})


@app.route("/analyze/retry-ai", methods=["POST", "OPTIONS"])
def retry_ai():
    """Re-runs only the AI steps that failed in the loaded analysis (see
    pipeline.retry_failed_ai) — no re-probe, proxy or thumbnail work."""
    if request.method == "OPTIONS":
        return ("", 204)
    if STORE.analysis_state != "complete":
        return jsonify({"accepted": False, "reason": "no-completed-analysis", "state": STORE.analysis_state})
    pending = pipeline.failed_ai_steps()
    project_failed = [t for t, e in STORE.ai_tasks.items() if e.get("status") == "failed"]
    if not pending and not project_failed:
        return jsonify({"accepted": False, "reason": "nothing-to-retry", "state": STORE.analysis_state})
    if not _analysis_lock.acquire(blocking=False):
        return jsonify({"accepted": False, "reason": "analysis-running", "state": STORE.analysis_state})

    def run():
        try:
            pipeline.retry_failed_ai()
        finally:
            _analysis_lock.release()

    threading.Thread(target=run, daemon=True).start()
    return jsonify({
        "accepted": True,
        "state": "running",
        "retrying": [{"clipId": c, "task": t} for c, t in pending] + [{"task": t} for t in project_failed],
    })


@app.route("/selects", methods=["GET"])
def selects():
    return jsonify({"selects": STORE.selects})


@app.route("/stories", methods=["GET"])
def stories():
    return jsonify({"stories": STORE.stories})


@app.route("/build", methods=["POST", "OPTIONS"])
def build():
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    project_id = body.get("projectId") or body.get("project")
    story_id = body.get("storyId") or body.get("story")
    target_seconds = float(body.get("targetSeconds") or 360)
    command = body.get("command") or body.get("prompt")
    result = pipeline.build_timeline(project_id, story_id, target_seconds, command)
    return jsonify(result)


@app.route("/propose", methods=["POST", "OPTIONS"])
def propose():
    """A Director edit proposal for the CURRENT sequence (worker/director.py).
    Returns a proposal for the app to validate and preview — never applies one."""
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    return jsonify(director.propose(body.get("instruction"), body.get("context")))


@app.route("/propose/story", methods=["POST", "OPTIONS"])
def propose_story():
    """A story plan (ids only) for the CURRENT sequence (worker/story.py).
    Returns a plan for the app to validate, compile and preview — never applies one."""
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    return jsonify(story.propose_story(body.get("instruction"), body.get("context")))


@app.route("/propose/coverage-rank", methods=["POST", "OPTIONS"])
def propose_coverage_rank():
    """An AI ranking of already-verified B-roll candidates for the CURRENT cut
    (worker/coverage_rank.py). Ids and reasons only — the app validates it and
    its deterministic planner places anything; nothing is applied here."""
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    return jsonify(coverage_rank.rank_coverage(body.get("context")))


@app.route("/restore", methods=["POST", "OPTIONS"])
def restore():
    """Loads the saved analysis for a project's media folder (persistence.py)
    after the app or worker restarted. Never touches a running analysis."""
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    project_id = body.get("projectId") or body.get("project")
    media_root = body.get("mediaRoot") or ""
    if not isinstance(media_root, str) or not os.path.isabs(media_root) or not os.path.isdir(media_root):
        return jsonify({"restored": False, "reason": "invalid-media-root"}), 400
    if STORE.analysis_state == "running":
        return jsonify({"restored": False, "reason": "analysis-running"})
    if (
        STORE.analysis_state == "complete"
        and STORE.media_root
        and os.path.realpath(STORE.media_root) == os.path.realpath(media_root)
    ):
        return jsonify({"restored": True, "reason": "already-loaded", "analysisId": STORE.analysis_id})
    return jsonify(persistence.restore_snapshot(STORE, project_id, media_root))


FRAME_WIDTHS = {160, 240, 320}
MAX_FRAMES_PER_REQUEST = 16


@app.route("/frames", methods=["POST", "OPTIONS"])
def frames():
    """Real frames of one analyzed clip at given SOURCE times (seconds), for
    the SELECTS / STORY / CUT visuals. Extracted from the clip's proxy when it
    has one (fast 960px H.264), else the original; cached under
    mediaRoot/.ae_thumbs/frames/ keyed by the source's identity, so a frame is
    only ever reused for the exact source version it came from."""
    if request.method == "OPTIONS":
        return ("", 204)
    body = request.get_json(silent=True) or {}
    clip = STORE.clips.get(str(body.get("clipId", "")))
    if clip is None or not STORE.media_root:
        return jsonify({"error": "unknown clip"}), 404
    width = body.get("width") if body.get("width") in FRAME_WIDTHS else 240
    times = [t for t in (body.get("times") or []) if isinstance(t, (int, float)) and not isinstance(t, bool)]
    times = times[:MAX_FRAMES_PER_REQUEST]
    root = Path(STORE.media_root)
    original = root / clip.rel_path
    proxy = root / clip.proxy_rel_path if clip.proxy_rel_path else None
    source = proxy if proxy is not None and media.cached_artifact_is_valid(proxy) else original
    key = clip.source_key or media.source_cache_key(original)
    if not key or not source.is_file():
        return jsonify({"error": "source media unavailable"}), 404
    last = max(0.0, (clip.duration_seconds or 0.0) - 0.05)
    out = []
    for t in times:
        seconds = round(min(max(0.0, float(t)), last), 3)
        rel = f"{media.THUMB_DIR_NAME}/frames/{key}-{int(seconds * 1000):08d}-w{width}.jpg"
        dest = root / rel
        if media.cached_artifact_is_valid(dest):
            out.append({"seconds": seconds, "relPath": rel})
            continue
        ok, error = media.extract_frame_at(source, dest, seconds, max_width=width, quality=6)
        out.append({"seconds": seconds, "relPath": rel} if ok else {"seconds": seconds, "error": error})
    return jsonify({"clipId": clip.id, "frames": out})


@app.route("/project", methods=["GET"])
def project():
    return jsonify({"project": STORE.project_json()})


@app.route("/nle", methods=["GET"])
def nle():
    # No Premiere/FCP/Resolve detection implemented here — the desktop companion's
    # own Premiere UXP bridge (electron/premiere-bridge.cjs) is a separate channel.
    return jsonify({"nle": []})


@app.errorhandler(Exception)
def handle_error(exc):
    log.error("unhandled error: %s", exc)
    return jsonify({"error": "The engine hit an unexpected error handling that request."}), 500


def _exit_when_parent_dies(parent_pid: int) -> None:
    """When the desktop app starts this worker it passes its own pid. If that
    process goes away without a clean quit (crash, force-quit, Ctrl+C in dev),
    we're reparented and getppid() changes — exit instead of lingering as an
    orphan holding port 32145."""
    import os
    import time

    def watch():
        while True:
            if os.getppid() != parent_pid:
                log.warning("parent process %s is gone — shutting down", parent_pid)
                os._exit(0)
            time.sleep(1.0)

    threading.Thread(target=watch, name="parent-watchdog", daemon=True).start()


def _selftest() -> int:
    """`server --selftest`: proves a (packaged) worker can import everything it
    needs at runtime and reports which ffmpeg/ffprobe it would run — without
    binding the port. Used by scripts/build-worker.sh after PyInstaller."""
    import importlib
    import importlib.metadata
    import json
    import platform
    import re
    import sys
    import warnings

    import media

    report = {
        "python": platform.python_version(),
        "arch": platform.machine(),
        "frozen": bool(getattr(sys, "frozen", False)),
        "modules": {},
        # Every installed distribution and its version — build-worker.sh checks
        # these against worker/requirements.lock.
        "distributions": {
            re.sub(r"[-_.]+", "-", d.metadata["Name"] or "").lower(): d.version
            for d in importlib.metadata.distributions()
        },
    }
    ok = True
    for name in ("flask", "werkzeug", "dotenv", "numpy", "openai", "anthropic", "httpx", "certifi",
                 "pydantic", "pydantic_core", "jiter",
                 "providers.anthropic_provider", "providers.openai_provider", "pipeline", "reasoning"):
        try:
            mod = importlib.import_module(name)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")  # e.g. Flask's deprecated __version__
                report["modules"][name] = getattr(mod, "__version__", "ok")
        except Exception as exc:  # noqa: BLE001 - report every missing module
            report["modules"][name] = f"MISSING: {exc}"
            ok = False
    report["tools"] = media.resolved_tool_paths()
    report["ffmpegAvailable"] = media.ffmpeg_available()
    print(json.dumps(report, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    import os
    import sys

    if "--selftest" in sys.argv:
        sys.exit(_selftest())

    import media
    from providers.base import ProviderError
    from providers.registry import get_reasoning_provider, get_transcription_provider

    tools = media.resolved_tool_paths()
    log.info("ffmpeg: %s | ffprobe: %s", tools["ffmpeg"], tools["ffprobe"])
    if not media.ffmpeg_available():
        log.warning("analysis will fail: %s", media.ffmpeg_missing_reason())

    # Provider-agnostic startup check: whichever vendor is selected (via
    # ASSISTANT_EDITOR_TRANSCRIPTION_PROVIDER / ASSISTANT_EDITOR_REASONING_PROVIDER,
    # see providers/registry.py) gets probed the same way — this never hardcodes
    # a specific vendor's env var name.
    try:
        transcription_provider = get_transcription_provider()
        log.info("Transcription provider: %s", transcription_provider.name)
    except ProviderError as exc:
        log.warning("Transcription provider unavailable — transcription will be skipped. %s", exc)
    try:
        reasoning_provider = get_reasoning_provider()
        log.info("Reasoning provider: %s", reasoning_provider.name)
    except ProviderError as exc:
        log.warning("Reasoning provider unavailable — selects/stories/build reasoning will be skipped. %s", exc)

    parent_pid = os.environ.get("ASSISTANT_EDITOR_PARENT_PID", "")
    if parent_pid.isdigit():
        _exit_when_parent_dies(int(parent_pid))

    log.info("Assistant Editor AI worker listening on http://%s:%s", HOST, PORT)
    # load_dotenv=False: Flask's own app.run() otherwise searches for .env /
    # .flaskenv from the CURRENT DIRECTORY upward and loads them — bypassing
    # ASSISTANT_EDITOR_SKIP_DOTENV above. A packaged worker runs from inside the
    # app bundle, so it would load whatever .env sits above wherever the app
    # was installed (found in the packaged-app smoke test: it picked up the
    # repo-root .env and made real API calls). Dotenv loading is handled
    # exclusively by the guarded load_dotenv() at the top of this file.
    app.run(host=HOST, port=PORT, threaded=True, load_dotenv=False)
