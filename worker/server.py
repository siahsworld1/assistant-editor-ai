"""Assistant Editor AI — local engine/worker.

Listens on 127.0.0.1:32145 (matching src/lib/ae/transport.ts::ENGINE_BASE_URL and
electron/allowlist.cjs::ENGINE_ORIGIN) and implements the contract the app's
EngineClient (src/lib/ae/service.ts) expects: /health, /analyze, /selects, /stories,
/build, /project, /nle.

Run: `python server.py` (see README.md for setup).
"""

from __future__ import annotations

import logging
import threading

from dotenv import load_dotenv

load_dotenv()

from flask import Flask, jsonify, request  # noqa: E402 - load_dotenv must run first

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


if __name__ == "__main__":
    import media
    from providers.base import ProviderError
    from providers.registry import get_reasoning_provider, get_transcription_provider

    if not media.ffmpeg_available():
        log.warning(
            "ffmpeg/ffprobe not found on PATH — analysis will fail until you `brew install ffmpeg`."
        )

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

    log.info("Assistant Editor AI worker listening on http://%s:%s", HOST, PORT)
    app.run(host=HOST, port=PORT, threaded=True)
