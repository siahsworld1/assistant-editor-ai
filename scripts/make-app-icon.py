#!/usr/bin/env python3
"""Builds the macOS app icon from the approved Assistant Editor AI artwork.

    .build/lock-tools/bin/python scripts/make-app-icon.py

(needs Pillow and numpy in that build-tools venv:
`.build/lock-tools/bin/python -m pip install Pillow==11.3.0 numpy==2.0.2`).

Input: assets/icon/source/assistant-editor-ai-icon-approved.webp — the approved
artwork exactly as supplied (checked against SOURCE_SHA256): a green-and-gold
rounded square on an opaque white background with a baked-in drop shadow,
filling ~94% of the canvas.

Approved conversion (nothing inside the rounded square is altered):
  1. cut the rounded square out along its own edge, traced from the artwork:
     for every direction from its centre (0.25° steps) the outermost artwork
     pixel — anything that is not the white/grey surround — lightly smoothed,
     then inset INSET_PX (measured: removes the blend with the background
     while keeping the gold rim's outline); anti-aliased by supersampling;
  2. drop everything outside it (the white background and baked shadow) —
     transparent;
  3. scale uniformly (aspect kept) onto Apple's macOS 1024 px icon grid:
     the rounded square 824 px wide, centred on a transparent 1024 canvas.

Outputs (committed):
  assets/icon/assistant-editor-ai-1024.png   high-resolution master (RGBA)
  assets/icon/AssistantEditorAI.icns         every macOS size, 16–1024 px
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "assets" / "icon"
SOURCE = ICON_DIR / "source" / "assistant-editor-ai-icon-approved.webp"
SOURCE_SHA256 = "255e61373c8dd33b353858ccdbabfd41a073d21b43f96c1d532874280a3840fe"
MASTER = ICON_DIR / "assistant-editor-ai-1024.png"
ICNS = ICON_DIR / "AssistantEditorAI.icns"

EDGE_STEPS = 1440  # directions traced around the centre (0.25°)
INSET_PX = 1.0
SUPERSAMPLE = 3
CANVAS = 1024
BODY_WIDTH = 824  # Apple macOS app icon grid

ICONSET = [  # (iconset file name, pixel size)
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]


def fail(msg: str) -> None:
    print(f"make-app-icon: {msg}", file=sys.stderr)
    sys.exit(1)


def is_artwork(rgb: np.ndarray) -> np.ndarray:
    """Everything that is not the white/light-grey surround: the rim's outline,
    the gold, the green. (The surround is near-neutral and light.)"""
    lum = rgb.mean(-1)
    chroma = rgb.max(-1) - rgb.min(-1)
    return (chroma >= 30) | (lum < 150)


def trace_edge(art: np.ndarray) -> tuple[float, float, np.ndarray, np.ndarray]:
    """Centre, and the outline's radius in every direction (smoothed)."""
    ys, xs = np.nonzero(art)
    cx, cy = (xs.min() + xs.max() + 1) / 2, (ys.min() + ys.max() + 1) / 2
    h, w = art.shape
    theta = np.arange(EDGE_STEPS) * 2 * np.pi / EDGE_STEPS
    steps = np.arange(0, max(w, h), 0.25)
    radius = np.empty(EDGE_STEPS)
    for i, t in enumerate(theta):
        px, py = cx + steps * np.cos(t), cy + steps * np.sin(t)
        ok = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        hits = np.nonzero(art[py[ok].astype(int), px[ok].astype(int)])[0]
        radius[i] = steps[ok][hits.max()] if len(hits) else 0.0

    def circular(values: np.ndarray, half: int, fn) -> np.ndarray:
        padded = np.concatenate([values[-half:], values, values[:half]])
        return np.array([fn(padded[j : j + 2 * half + 1]) for j in range(len(values))])

    radius = circular(circular(radius, 4, np.median), 2, np.mean)  # despeckle, then smooth
    return cx, cy, theta, radius


def edge_mask(width: int, height: int, cx: float, cy: float, theta: np.ndarray, radius: np.ndarray) -> np.ndarray:
    """Anti-aliased alpha (0..1) inside the traced outline, at source resolution."""
    alpha = np.zeros((height, width))
    offsets = (np.arange(SUPERSAMPLE) + 0.5) / SUPERSAMPLE
    gy, gx = np.mgrid[0:height, 0:width].astype(float)
    for oy in offsets:
        for ox in offsets:
            dx, dy = gx + ox - cx, gy + oy - cy
            edge = np.interp(np.arctan2(dy, dx) % (2 * np.pi), theta, radius, period=2 * np.pi)
            alpha += np.hypot(dx, dy) <= edge - INSET_PX
    return alpha / SUPERSAMPLE**2


def main() -> None:
    data = SOURCE.read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        fail(f"{SOURCE.relative_to(ROOT)} is not the approved artwork (SHA-256 mismatch)")
    src = Image.open(SOURCE).convert("RGB")
    w, h = src.size

    pixels = np.asarray(src, dtype=np.uint8)
    cx, cy, theta, radius = trace_edge(is_artwork(pixels.astype(float)))
    alpha = (edge_mask(w, h, cx, cy, theta, radius) * 255 + 0.5).astype(np.uint8)
    cut = Image.fromarray(np.dstack([pixels, alpha]))  # 4 channels -> RGBA
    body = cut.crop(cut.getchannel("A").getbbox())

    scale = BODY_WIDTH / body.width
    size = (BODY_WIDTH, round(body.height * scale))
    # Resample with premultiplied alpha so transparent pixels can't bleed colour.
    body = body.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")
    master = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    master.paste(body, ((CANVAS - size[0]) // 2, (CANVAS - size[1]) // 2), body)
    master.save(MASTER, optimize=True)

    if not shutil.which("iconutil"):
        fail("iconutil (macOS) is required to build the .icns")
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "AssistantEditorAI.iconset"
        iconset.mkdir()
        for name, px in ICONSET:
            img = master if px == CANVAS else master.convert("RGBa").resize((px, px), Image.Resampling.LANCZOS).convert("RGBA")
            img.save(iconset / name)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(ICNS)], check=True)
    print(f"make-app-icon: {MASTER.relative_to(ROOT)} (body {size[0]}x{size[1]} on {CANVAS}x{CANVAS}), {ICNS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
