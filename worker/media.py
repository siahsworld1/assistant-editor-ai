"""Media ingestion helpers: walking a media folder, probing files with ffmpeg/ffprobe,
extracting audio + sample frames, inferring role/speaker from filenames, and a real
(signal-processing) hum detector. No AI calls live in this file.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import wave
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("assistant-editor-worker")

MEDIA_EXTENSIONS = {
    ".mov", ".mp4", ".mxf", ".m4v", ".avi", ".mkv", ".braw", ".r3d", ".arri", ".ari",
    ".wav", ".aif", ".aiff", ".mp3", ".flac", ".m4a",
}
AUDIO_ONLY_EXTENSIONS = {".wav", ".aif", ".aiff", ".mp3", ".flac", ".m4a"}

MAX_FILES = 500
MAX_DEPTH = 6

# Single shared timeout for every ffprobe invocation in this module — production
# camera-original footage (large 4K H.265/HEVC files in particular) can
# genuinely need more than a token few seconds for ffprobe to read container +
# stream metadata, especially over slower storage. One real, generous budget,
# retried once on a genuine timeout (see FFPROBE_MAX_ATTEMPTS below) beats
# guessing a "safe" number that's still too tight for some real footage.
FFPROBE_TIMEOUT_SECONDS = 120
# Total attempts for a single ffprobe_info() call, including the first. Only a
# genuine timeout triggers a retry — a real failure (bad exit code, corrupt
# file, no streams) is not retried, since running the same probe again against
# the same unreadable bytes would not produce a different answer. This bounds
# the worst case for one file at FFPROBE_MAX_ATTEMPTS * FFPROBE_TIMEOUT_SECONDS
# — ffprobe can never hang indefinitely.
FFPROBE_MAX_ATTEMPTS = 2


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@dataclass
class MediaFile:
    path: Path
    filename: str
    ext: str
    role: str  # "interview" | "b-roll" | "ambient"
    speaker: str | None
    duration_seconds: float = 0.0
    resolution: str = "—"
    fps: float = 24.0
    camera: str = "—"
    has_audio: bool = False


def walk_media_root(root: str) -> list[Path]:
    """Metadata-free walk: just find candidate media files under root."""
    base = Path(root).expanduser()
    if not base.exists() or not base.is_dir():
        return []
    found: list[Path] = []

    def walk(dir_path: Path, depth: int):
        if depth > MAX_DEPTH or len(found) >= MAX_FILES:
            return
        try:
            entries = sorted(dir_path.iterdir())
        except OSError:
            return
        for entry in entries:
            if len(found) >= MAX_FILES:
                return
            if entry.name.startswith("."):
                continue
            if entry.is_symlink():
                continue
            if entry.is_dir():
                walk(entry, depth + 1)
            elif entry.is_file() and entry.suffix.lower() in MEDIA_EXTENSIONS:
                found.append(entry)

    walk(base, 0)
    return found


# Mirrors electron/desktop-capabilities.cjs roleForFile, in Python.
_INTERVIEW_RE = re.compile(r"(^|[^a-z])(int|interview|ivw|cam[ab])([^a-z]|$)", re.IGNORECASE)
_BROLL_RE = re.compile(r"(^|[^a-z])(b[-_ ]?roll|broll|gv|cutaway)([^a-z]|$)", re.IGNORECASE)


def role_for_file(filename: str, ext: str) -> str:
    if ext in AUDIO_ONLY_EXTENSIONS:
        return "ambient"
    base = filename.lower()
    if _INTERVIEW_RE.search(base):
        return "interview"
    if _BROLL_RE.search(base):
        return "b-roll"
    return "interview"


# Best-effort speaker extraction: look for an underscore/dash-delimited token that
# follows an "INT"/"INTERVIEW" marker, e.g. A001_INT_MARISOL_01.mov -> "Marisol".
# Falls back to None (caller assigns a generic "Speaker N" label) when no
# recognizable pattern exists — real footage may not follow this convention at all.
_SPEAKER_TOKEN_RE = re.compile(
    r"(?:^|[_\-\s])(?:int|interview|ivw)[_\-\s]+([a-zA-Z]+)(?:[_\-\s]|\.|$)",
    re.IGNORECASE,
)


def speaker_for_file(filename: str) -> str | None:
    stem = Path(filename).stem
    m = _SPEAKER_TOKEN_RE.search(stem)
    if m:
        return m.group(1).capitalize()
    return None


def _ffprobe_failure(reason: str) -> dict:
    """The shared 'we learned nothing real about this file' shape. `ok: False` is
    the only reliable signal a caller can use to tell this apart from a
    legitimately quiet file — every other field here is just a safe default, not
    a real measurement, and must never be presented to the user as one."""
    return {
        "duration": 0.0, "resolution": "—", "fps": 24.0, "has_audio": False, "camera": "—",
        "ok": False, "probeError": reason[:300],
    }


def _run_ffprobe_once(path: Path, timeout: float) -> subprocess.CompletedProcess:
    """One real ffprobe invocation. Raises subprocess.TimeoutExpired or OSError —
    callers decide what to do with those, this just runs the process."""
    return subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, timeout=timeout,
    )


def ffprobe_info(path: Path) -> dict:
    """Returns duration/resolution/fps/has_audio/camera via ffprobe, plus
    `ok`/`probeError`. `ok` is False whenever ffprobe couldn't actually tell us
    anything real about this file — missing binary, timeout (after one retry —
    see below), non-zero exit, unparsable output, or a file with no video *and*
    no audio stream. Callers must treat `ok: False` as "this clip could not be
    analyzed", not as "an audio-only file with unknown duration" — the two used
    to be indistinguishable (both produced this exact same defaults shape),
    which is how a genuinely unreadable file could end up silently marked
    "ready" with 0:00 and no metadata instead of a real, visible error.

    Retries exactly once, and only on a genuine timeout: a real 4K H.265/HEVC
    camera-original file can legitimately take longer than a short, fixed
    budget to probe (slow external storage, a large/complex container), and a
    single slow-but-fine run shouldn't be reported the same as truly unreadable
    media. A non-timeout failure (bad exit code, corrupt bytes, no streams) is
    never retried — running ffprobe again against the same bad bytes cannot
    produce a different answer. The retry is bounded to one extra attempt at
    the same FFPROBE_TIMEOUT_SECONDS budget, so ffprobe can never hang
    indefinitely on a single clip: worst case is
    FFPROBE_MAX_ATTEMPTS * FFPROBE_TIMEOUT_SECONDS, not unbounded.
    """
    if not ffmpeg_available():
        return _ffprobe_failure("ffmpeg/ffprobe not found on PATH")

    proc: subprocess.CompletedProcess | None = None
    for attempt in range(1, FFPROBE_MAX_ATTEMPTS + 1):
        try:
            proc = _run_ffprobe_once(path, FFPROBE_TIMEOUT_SECONDS)
            break
        except subprocess.TimeoutExpired:
            if attempt < FFPROBE_MAX_ATTEMPTS:
                log.warning(
                    "ffprobe timed out after %ss on %s (attempt %d/%d) — retrying once",
                    FFPROBE_TIMEOUT_SECONDS, path.name, attempt, FFPROBE_MAX_ATTEMPTS,
                )
                continue
            retries = FFPROBE_MAX_ATTEMPTS - 1
            reason = f"ffprobe timed out after {FFPROBE_TIMEOUT_SECONDS}s"
            if retries:
                reason += f" ({retries} retry still timed out)"
            return _ffprobe_failure(reason)
        except OSError as exc:
            return _ffprobe_failure(f"could not run ffprobe: {exc}")

    assert proc is not None  # loop only exits via break (success) or an early return above
    if proc.returncode != 0:
        stderr_lines = (proc.stderr or "").strip().splitlines()
        reason = stderr_lines[-1] if stderr_lines else f"ffprobe exited with status {proc.returncode}"
        return _ffprobe_failure(reason)

    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        return _ffprobe_failure(f"ffprobe returned unparsable output: {exc}")

    fmt = data.get("format", {}) or {}
    streams = data.get("streams", []) or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    if video is None and audio is None:
        return _ffprobe_failure("ffprobe found no video or audio streams in this file")

    duration = float(fmt.get("duration") or (video or {}).get("duration") or 0.0)
    resolution = "—"
    fps = 24.0
    camera = "—"
    if video:
        w, h = video.get("width"), video.get("height")
        if w and h:
            resolution = f"{w}x{h}"
        rate = video.get("avg_frame_rate") or video.get("r_frame_rate") or "24/1"
        try:
            num, den = rate.split("/")
            fps = round(float(num) / float(den), 3) if float(den) else 24.0
        except (ValueError, ZeroDivisionError):
            fps = 24.0
        camera = video.get("codec_long_name", "—") or "—"
    elif audio:
        rate = audio.get("sample_rate")
        bits = audio.get("bits_per_sample") or audio.get("bits_per_raw_sample")
        resolution = f"{rate}Hz" + (f" / {bits}-bit" if bits else "") if rate else "—"
        fps = 0.0
        camera = audio.get("codec_long_name", "—") or "—"

    return {
        "duration": duration,
        "resolution": resolution,
        "fps": fps,
        "has_audio": audio is not None,
        "camera": camera,
        "ok": True,
        "probeError": None,
    }


def extract_audio(path: Path, out_wav: Path) -> bool:
    """Extracts mono 16kHz PCM WAV — good for both Whisper upload and hum analysis."""
    if not ffmpeg_available():
        return False
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000",
                "-f", "wav", str(out_wav),
            ],
            capture_output=True, timeout=600, check=True,
        )
        return out_wav.exists() and out_wav.stat().st_size > 0
    except (subprocess.SubprocessError, OSError):
        return False


def extract_frames(path: Path, out_dir: Path, count: int = 8) -> list[Path]:
    """Extracts `count` evenly spaced frames as JPEGs for vision analysis."""
    if not ffmpeg_available():
        return []
    info = ffprobe_info(path)
    duration = info["duration"] or 0.0
    if duration <= 0:
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    frames: list[Path] = []
    step = duration / (count + 1)
    for i in range(1, count + 1):
        ts = step * i
        out_path = out_dir / f"frame_{i:02d}.jpg"
        try:
            subprocess.run(
                [
                    "ffmpeg", "-y", "-ss", f"{ts:.2f}", "-i", str(path),
                    "-frames:v", "1", "-q:v", "3", str(out_path),
                ],
                capture_output=True, timeout=60, check=True,
            )
            if out_path.exists() and out_path.stat().st_size > 0:
                frames.append(out_path)
        except (subprocess.SubprocessError, OSError):
            continue
    return frames


PROXY_MAX_WIDTH = 960
PROXY_DIR_NAME = ".ae_proxies"


def generate_proxy(src: Path, dest: Path, max_width: int = PROXY_MAX_WIDTH) -> bool:
    """Transcodes `src` to an H.264/AAC MP4 proxy at `dest`, scaled to at most
    `max_width` wide (never upscaled), with a moov atom at the front
    (`-movflags +faststart`) so it starts streaming/seeking immediately over the
    ae-media:// protocol instead of needing the whole file first.

    This exists for two real reasons, not just as a checklist item:
      1. Chromium's <video> element cannot decode many professional camera
         formats at all (ProRes in a .mov, various MXF wrappers, some HEVC
         variants) — without a proxy, in-app preview would silently fail to
         play the original master on a real documentary shoot.
      2. A 960px H.264 proxy scrubs smoothly; a 4K/6K camera original does not,
         even when Chromium *can* decode it.

    Returns False (never raises) on any failure — proxy generation is a
    best-effort preview convenience, not something that should ever fail the
    analysis pass for that clip.
    """
    if not ffmpeg_available():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    scale_filter = f"scale='min({max_width},iw)':-2"
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(src),
                "-vf", scale_filter,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                str(dest),
            ],
            capture_output=True, timeout=1800, check=True,
        )
        return dest.exists() and dest.stat().st_size > 0
    except (subprocess.SubprocessError, OSError):
        dest.unlink(missing_ok=True)
        return False


def proxy_is_current(src: Path, dest: Path) -> bool:
    """True if `dest` already exists and is newer than `src` — used to skip
    re-encoding on repeat Analyze runs when the source file hasn't changed."""
    try:
        return dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime
    except OSError:
        return False


THUMB_DIR_NAME = ".ae_thumbs"
THUMB_MAX_WIDTH = 480


def generate_thumbnail(
    src: Path, dest: Path, duration_seconds: float, max_width: int = THUMB_MAX_WIDTH,
) -> tuple[bool, str | None]:
    """Extracts a single real JPEG frame ~15% into the clip (never frame 0, which
    on real footage is disproportionately likely to be a lens cap, black, or a
    slate) for use as a WATCH-page media-bin thumbnail.

    Deliberately the cheapest real thing that could work: one frame, no AI call —
    this runs before the (potentially many-minute) proxy transcode so a real
    thumbnail shows up in the UI almost immediately after Analyze starts, not
    just once the whole clip has finished. Never raises; a failed thumbnail just
    means the UI shows its placeholder tile, exactly like a failed proxy falls
    back to the original file — but unlike the old bool-only return, the caller
    now gets the real ffmpeg failure reason to log/surface instead of a silent
    "didn't work, don't know why".

    Timeout is 90s, not the 30s originally used: a real single-frame seek+decode
    is normally sub-second, but `-ss` before `-i` still has to decode forward
    from the nearest keyframe, and on a long-GOP camera-original file that can
    take meaningfully longer than a synthetic test clip does — 90s stays far
    short of the proxy transcode's own 1800s budget while giving real footage
    real headroom instead of failing on a slow-but-fine seek.
    """
    if not ffmpeg_available():
        return False, "ffmpeg/ffprobe not found on PATH"
    dest.parent.mkdir(parents=True, exist_ok=True)
    ts = max(0.1, (duration_seconds or 0.0) * 0.15)
    scale_filter = f"scale='min({max_width},iw)':-2"
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-y", "-ss", f"{ts:.2f}", "-i", str(src),
                "-frames:v", "1", "-vf", scale_filter, "-q:v", "4",
                str(dest),
            ],
            capture_output=True, timeout=90,
        )
    except subprocess.TimeoutExpired:
        dest.unlink(missing_ok=True)
        return False, "ffmpeg timed out after 90s"
    except OSError as exc:
        dest.unlink(missing_ok=True)
        return False, f"could not run ffmpeg: {exc}"

    if proc.returncode != 0 or not (dest.exists() and dest.stat().st_size > 0):
        dest.unlink(missing_ok=True)
        stderr_lines = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        reason = stderr_lines[-1] if stderr_lines else f"ffmpeg exited with status {proc.returncode}"
        return False, reason[:300]

    return True, None


def thumbnail_is_current(src: Path, dest: Path) -> bool:
    """True if `dest` already exists and is newer than `src` — mirrors
    proxy_is_current so repeat Analyze runs don't re-extract an unchanged frame."""
    try:
        return dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime
    except OSError:
        return False


def frame_timecode(index: int, count: int, duration: float, fps: float = 24.0) -> str:
    step = duration / (count + 1)
    seconds = step * (index + 1)
    return seconds_to_tc(seconds, fps)


def seconds_to_tc(seconds: float, fps: float = 24.0) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    f = int((seconds - int(seconds)) * (fps or 24))
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def tc_to_seconds(tc: str, fps: float = 24.0) -> float | None:
    """Inverse of seconds_to_tc. Returns None for anything that isn't a well-formed
    HH:MM:SS:FF (or HH:MM:SS) timecode — callers must treat that as invalid, not 0."""
    if not isinstance(tc, str):
        return None
    parts = tc.strip().split(":")
    if len(parts) not in (3, 4):
        return None
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if len(nums) == 3:
        h, m, s = nums
        f = 0
    else:
        h, m, s, f = nums
    if m >= 60 or s >= 60 or f >= max(1, round(fps or 24)) or min(h, m, s, f) < 0:
        return None
    return h * 3600 + m * 60 + s + f / (fps or 24)


def detect_hum(wav_path: Path) -> list[str]:
    """Real FFT-based mains-hum detector: flags sustained energy spikes at 50/60Hz
    (and their 2nd harmonic) relative to the surrounding spectrum."""
    try:
        import numpy as np
    except ImportError:
        return []
    if not wav_path.exists():
        return []
    try:
        with wave.open(str(wav_path), "rb") as w:
            n_frames = w.getnframes()
            rate = w.getframerate()
            sampwidth = w.getsampwidth()
            raw = w.readframes(n_frames)
    except (OSError, wave.Error):
        return []
    if not raw or rate <= 0:
        return []

    dtype = {1: np.int8, 2: np.int16, 4: np.int32}.get(sampwidth, np.int16)
    samples = np.frombuffer(raw, dtype=dtype).astype(np.float64)
    if samples.size == 0:
        return []
    samples = samples - samples.mean()

    # Cap FFT size for speed on long clips.
    max_samples = rate * 60  # analyze up to 60s of audio
    if samples.size > max_samples:
        samples = samples[:max_samples]

    windowed = samples * np.hanning(samples.size)
    spectrum = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(samples.size, d=1.0 / rate)

    issues: list[str] = []

    def band_energy(target_hz: float, tolerance: float = 2.0) -> float:
        mask = (freqs >= target_hz - tolerance) & (freqs <= target_hz + tolerance)
        return float(spectrum[mask].mean()) if mask.any() else 0.0

    baseline = float(np.median(spectrum)) or 1e-9
    for hz, label in ((60.0, "60Hz"), (120.0, "120Hz"), (50.0, "50Hz")):
        energy = band_energy(hz)
        if energy > baseline * 6:
            issues.append(f"Electrical hum {label}")
            break  # 50Hz and 60Hz are mutually exclusive mains frequencies

    return issues
