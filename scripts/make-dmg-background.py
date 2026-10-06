#!/usr/bin/env python3
"""Builds the DMG window background from the approved artwork.

    .build/lock-tools/bin/python scripts/make-dmg-background.py

(needs Pillow in that build-tools venv: `.build/lock-tools/bin/python -m pip install Pillow==11.3.0`).

Input: assets/dmg/source/dmg-background-approved.webp — the approved artwork
exactly as supplied (checked against SOURCE_SHA256), 1536x1024, with two framed
spaces either side of the arrow where Finder draws the app and the
Applications link (positions in package.json build.dmg.contents).

Output (committed): assets/dmg/background.tiff — a multi-resolution TIFF for a
768x512-point DMG window: the artwork unchanged as the @2x (Retina) image, and
a Lanczos-downscaled 768x512 copy for standard displays.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "dmg" / "source" / "dmg-background-approved.webp"
SOURCE_SHA256 = "1e241ddfeb065573cac48b338a89dc86d7dceb8960d7785396cad0efcfa0436e"
OUTPUT = ROOT / "assets" / "dmg" / "background.tiff"
WINDOW = (768, 512)  # points; the artwork is exactly 2x


def fail(msg: str) -> None:
    print(f"make-dmg-background: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    data = SOURCE.read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA256:
        fail(f"{SOURCE.relative_to(ROOT)} is not the approved artwork (SHA-256 mismatch)")
    art = Image.open(SOURCE).convert("RGB")
    if art.size != (WINDOW[0] * 2, WINDOW[1] * 2):
        fail(f"artwork is {art.size}, expected {WINDOW[0] * 2}x{WINDOW[1] * 2}")
    with tempfile.TemporaryDirectory() as tmp:
        x1, x2 = Path(tmp) / "background.png", Path(tmp) / "background@2x.png"
        art.resize(WINDOW, Image.Resampling.LANCZOS).save(x1)
        art.save(x2)
        # tiffutil pairs a 1x image with its exactly-2x counterpart (HiDPI TIFF).
        subprocess.run(["tiffutil", "-cathidpicheck", str(x1), str(x2), "-out", str(OUTPUT)], check=True, capture_output=True)
    print(f"make-dmg-background: {OUTPUT.relative_to(ROOT)} ({WINDOW[0]}x{WINDOW[1]} pt, 1x + 2x)")


if __name__ == "__main__":
    main()
