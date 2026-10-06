"""The FFmpeg shipped in the app is built by scripts/prepare-ffmpeg.py. These
tests pin what that build may contain — LGPL only, arm64, macOS 14 — and the
checks the script runs against the binaries it produces. No build happens here.

Run from worker/: `python3 -m unittest discover -s tests -v`
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import tests._no_real_credentials  # noqa: E402,F401 - must run before anything else

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prepare-ffmpeg.py"
_spec = importlib.util.spec_from_file_location("prepare_ffmpeg", SCRIPT)
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)

LGPL_NOTICE = """ffmpeg is free software; you can redistribute it and/or
modify it under the terms of the GNU Lesser General Public
License as published by the Free Software Foundation; either
version 2.1 of the License, or (at your option) any later version.
"""
GPL_NOTICE = """ffmpeg is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 3 of the License, or
(at your option) any later version.
"""


class TestConfiguration(unittest.TestCase):
    def test_pinned_release_and_target(self):
        self.assertRegex(build.FFMPEG_VERSION, r"^\d+\.\d+\.\d+$")
        self.assertTrue(build.SOURCE_URL.startswith("https://ffmpeg.org/releases/"))
        self.assertRegex(build.SOURCE_SHA256, r"^[0-9a-f]{64}$")
        self.assertEqual(build.DEPLOYMENT_TARGET, "14.0")
        self.assertEqual(build.ARCH, "arm64")
        flags = build.CONFIGURE_FLAGS
        self.assertIn("--arch=aarch64", flags)
        self.assertIn("--extra-cflags=-mmacosx-version-min=14.0", flags)
        self.assertIn("--extra-ldflags=-mmacosx-version-min=14.0", flags)

    def test_no_gpl_version3_nonfree_or_external_library(self):
        for flag in build.CONFIGURE_FLAGS:
            self.assertIsNone(build.FORBIDDEN_FLAG.fullmatch(flag.split("=")[0]), flag)
        self.assertIn("--disable-autodetect", build.CONFIGURE_FLAGS)
        self.assertIn("--disable-network", build.CONFIGURE_FLAGS)

    def test_encodes_proxies_with_videotoolbox_not_x264(self):
        self.assertIn("h264_videotoolbox", build.ENCODERS)
        self.assertIn("--enable-videotoolbox", build.CONFIGURE_FLAGS)
        self.assertTrue(set(build.ABSENT_ENCODERS) >= {"libx264", "libx265"})
        self.assertFalse(set(build.ENCODERS) & set(build.ABSENT_ENCODERS))

    def test_covers_what_the_worker_uses(self):
        # worker/media.py: H.264 proxy + AAC in MP4, JPEG frames, 16 kHz WAV.
        for enc in ("h264_videotoolbox", "aac", "mjpeg", "pcm_s16le"):
            self.assertIn(enc, build.ENCODERS)
        for mux in ("mp4", "wav", "image2"):
            self.assertIn(mux, build.MUXERS)
        for dec in ("hevc", "h264", "aac"):
            self.assertIn(dec, build.REQUIRED["decoders"])


class TestBinaryChecks(unittest.TestCase):
    def test_licence_check_accepts_lgpl_and_rejects_gpl(self):
        self.assertEqual(build.licence_problems(LGPL_NOTICE, "--enable-videotoolbox --enable-zlib"), [])
        self.assertTrue(build.licence_problems(GPL_NOTICE, ""))
        self.assertTrue(build.licence_problems(LGPL_NOTICE, "--enable-gpl --enable-libx264"))
        self.assertTrue(build.licence_problems(LGPL_NOTICE, "--enable-version3"))
        self.assertTrue(build.licence_problems(LGPL_NOTICE, "--enable-nonfree"))

    def test_reads_the_minimum_macos_from_load_commands(self):
        otool = "Load command 9\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 14.0\n      sdk 26.5\n"
        self.assertEqual(build.macos_minimum(otool), "14.0")
        self.assertIsNone(build.macos_minimum("Load command 1\n cmd LC_UUID\n"))
        self.assertGreater(build.version_tuple("26.0"), build.version_tuple(build.DEPLOYMENT_TARGET))
        self.assertLessEqual(build.version_tuple("11.0"), build.version_tuple(build.DEPLOYMENT_TARGET))

    def test_parses_component_listings(self):
        listing = (
            "Encoders:\n V..... = Video\n ------\n"
            " V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)\n"
            " A....D aac                  AAC (Advanced Audio Coding)\n"
        )
        self.assertEqual(build.component_names(listing), {"h264_videotoolbox", "aac"})
        formats = "Formats:\n D.. = Demuxing supported\n ---\n D   mov,mp4,m4a  QuickTime / MOV\n"
        self.assertEqual(build.component_names(formats), {"mov", "mp4", "m4a"})


if __name__ == "__main__":
    unittest.main()
