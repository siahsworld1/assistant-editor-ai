#!/usr/bin/env python3
"""Builds the ffmpeg/ffprobe shipped inside the packaged macOS app.

    npm run ffmpeg:prepare

A reproducible, minimal, LGPL-only FFmpeg built from a pinned upstream release
— never copied from whatever Homebrew (or anything else) has installed:

  1. downloads the pinned source tarball from ffmpeg.org into .build/ffmpeg/
     (reused if present) and verifies its SHA-256;
  2. unpacks a fresh tree and configures it with CONFIGURE_FLAGS below in a
     scrubbed environment (system PATH only, no pkg-config, no Homebrew
     include/library paths), for arm64 / macOS DEPLOYMENT_TARGET;
  3. builds static ffmpeg + ffprobe (no bundled dylibs) into dist-ffmpeg/bin/;
  4. VERIFIES the binaries themselves, not the flags: arch, the Mach-O minimum
     macOS, that they link only OS libraries, that FFmpeg reports itself as
     LGPL with no GPL/nonfree/version3 component, that the codecs Assistant
     Editor AI needs are present (and x264/x265 are not), and that both tools
     run with nothing but the OS on PATH;
  5. writes the licence, notice and exact build information alongside them.

electron-builder copies dist-ffmpeg/ into the app as Resources/ffmpeg
(package.json "extraResources"); electron/worker-supervisor.cjs points the
worker at it.

What the app needs from FFmpeg (worker/media.py): ffprobe metadata; decoding
camera originals (HEVC/H.264 and AAC/PCM audio, plus every other native
decoder so unusual footage still opens); scaling; H.264 proxies encoded by
Apple VideoToolbox with AAC audio in MP4; JPEG frames; 16 kHz mono WAV audio.
Encoders, muxers and protocols are limited to exactly that; decoders,
demuxers, parsers and filters keep FFmpeg's native (LGPL) defaults.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / ".build" / "ffmpeg"
OUT = ROOT / "dist-ffmpeg"
TOOLS = ("ffmpeg", "ffprobe")

FFMPEG_VERSION = "9.0.2"
SOURCE_URL = f"https://ffmpeg.org/releases/ffmpeg-{FFMPEG_VERSION}.tar.xz"
# Matches the checksum Homebrew independently publishes for this release.
SOURCE_SHA256 = "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"
DEPLOYMENT_TARGET = "14.0"
ARCH = "arm64"

ENCODERS = ("h264_videotoolbox", "aac", "mjpeg", "pcm_s16le", "wrapped_avframe")
MUXERS = ("mp4", "mov", "wav", "image2", "image2pipe", "null")
PROTOCOLS = ("file", "pipe")

CONFIGURE_FLAGS = (
    "--cc=/usr/bin/clang",
    "--arch=aarch64",
    "--target-os=darwin",
    "--pkg-config=false",
    f"--extra-cflags=-mmacosx-version-min={DEPLOYMENT_TARGET}",
    f"--extra-ldflags=-mmacosx-version-min={DEPLOYMENT_TARGET}",
    "--extra-version=assistant-editor-ai",
    # Static ffmpeg/ffprobe: no dylibs to relocate or sign separately.
    "--enable-static",
    "--disable-shared",
    # Never pick up optional libraries just because a build machine has them;
    # the only system pieces used are named explicitly (all ship with macOS).
    "--disable-autodetect",
    "--enable-videotoolbox",
    "--enable-zlib",
    "--enable-bzlib",
    "--enable-pthreads",
    "--disable-programs",
    "--enable-ffmpeg",
    "--enable-ffprobe",
    "--disable-doc",
    "--disable-debug",
    "--disable-avdevice",
    "--disable-network",
    "--disable-encoders",
    f"--enable-encoder={','.join(ENCODERS)}",
    "--disable-muxers",
    f"--enable-muxer={','.join(MUXERS)}",
    "--disable-protocols",
    f"--enable-protocol={','.join(PROTOCOLS)}",
)
# Must never appear: they would change the licence (GPL / GPLv3 / nonfree) or
# pull in third-party libraries the app doesn't use.
FORBIDDEN_FLAG = re.compile(r"--enable-(gpl|version3|nonfree|lib[a-z0-9_-]+|openssl|gnutls|securetransport)\b")

REQUIRED = {
    "decoders": ("hevc", "h264", "aac", "pcm_s16le", "pcm_s24le", "prores", "mjpeg"),
    "encoders": ENCODERS,
    "demuxers": ("mov", "matroska", "mxf", "wav"),
    "muxers": MUXERS,
    "filters": ("scale", "aresample", "format", "aformat"),
}
ABSENT_ENCODERS = ("libx264", "libx265", "libsvtav1", "libvpx", "libmp3lame", "libopus")

SYSTEM_PREFIXES = ("/usr/lib/", "/System/")
CLEAN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


def fail(msg: str) -> None:
    print(f"prepare-ffmpeg: {msg}", file=sys.stderr)
    sys.exit(1)


def log(msg: str) -> None:
    print(f"prepare-ffmpeg: {msg}", flush=True)


def run(*args: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw)


def build_env() -> dict:
    """System toolchain only: nothing from Homebrew, pkg-config or the user's
    shell can leak into configure or the compiler."""
    env = {
        "PATH": CLEAN_PATH,
        "HOME": os.environ.get("HOME", "/"),
        "LANG": "C",
        "LC_ALL": "C",
        "MACOSX_DEPLOYMENT_TARGET": DEPLOYMENT_TARGET,
        "SDKROOT": run("/usr/bin/xcrun", "--show-sdk-path", env={"PATH": CLEAN_PATH}).stdout.strip(),
        "TMPDIR": os.environ.get("TMPDIR", "/tmp"),
    }
    return env


# --------------------------------------------------------------------------- #
# Checks on the built binaries (pure functions are unit-tested)
# --------------------------------------------------------------------------- #
def macos_minimum(load_commands: str) -> str | None:
    """The `minos` of LC_BUILD_VERSION (or LC_VERSION_MIN_MACOSX) from `otool -l`."""
    lines = load_commands.splitlines()
    for i, line in enumerate(lines):
        cmd = line.strip()
        if cmd in ("cmd LC_BUILD_VERSION", "cmd LC_VERSION_MIN_MACOSX"):
            key = "minos" if cmd.endswith("BUILD_VERSION") else "version"
            for follow in lines[i + 1 : i + 6]:
                parts = follow.split()
                if parts and parts[0] == key:
                    return parts[1]
    return None


def version_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def licence_problems(license_text: str, buildconf: str) -> list[str]:
    """Problems with `ffmpeg -L` / `ffmpeg -buildconf` output for a build that
    must be LGPL v2.1-or-later with no GPL, v3-only or nonfree component."""
    problems = []
    license_text = " ".join(license_text.split())  # the notice is line-wrapped
    if "GNU Lesser General Public License" not in license_text or "version 2.1" not in license_text:
        problems.append("ffmpeg -L does not report LGPL version 2.1 or later")
    if "GNU General Public License as published" in license_text:
        problems.append("ffmpeg -L reports the GPL")
    if "nonfree" in license_text.lower() or "unredistributable" in license_text.lower():
        problems.append("ffmpeg -L reports a nonfree build")
    for flag in re.findall(r"--enable-[a-z0-9_-]+", buildconf):
        if FORBIDDEN_FLAG.fullmatch(flag):
            problems.append(f"build configuration contains {flag}")
    return problems


def component_names(listing: str) -> set[str]:
    """Names from `ffmpeg -encoders`/`-decoders`/`-muxers`/`-demuxers`/`-filters`."""
    names: set[str] = set()
    in_body = False
    for line in listing.splitlines():
        parts = line.split()
        if not in_body:
            # The legend ends with a line of dashes; entries follow it as
            # "<flags> <name[,alias]> <description>".
            in_body = len(parts) == 1 and set(parts[0]) == {"-"}
            continue
        if len(parts) >= 2:
            names.update(parts[1].split(","))
    return names


# --------------------------------------------------------------------------- #
# Build
# --------------------------------------------------------------------------- #
def fetch_source() -> Path:
    WORK.mkdir(parents=True, exist_ok=True)
    tarball = WORK / f"ffmpeg-{FFMPEG_VERSION}.tar.xz"
    if not tarball.exists():
        log(f"downloading {SOURCE_URL}")
        partial = tarball.with_suffix(".partial")
        with urllib.request.urlopen(SOURCE_URL, timeout=120) as resp, open(partial, "wb") as fh:
            shutil.copyfileobj(resp, fh)
        os.replace(partial, tarball)
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        tarball.unlink()
        fail(f"{tarball.name} SHA-256 {digest} != pinned {SOURCE_SHA256} (deleted; re-run to download again)")
    return tarball


def build(tarball: Path) -> Path:
    src = WORK / f"ffmpeg-{FFMPEG_VERSION}"
    shutil.rmtree(src, ignore_errors=True)
    with tarfile.open(tarball) as tf:
        tf.extractall(WORK)
    env = build_env()
    log(f"configuring FFmpeg {FFMPEG_VERSION} for {ARCH} / macOS {DEPLOYMENT_TARGET}")
    # Configure and build in-tree with relative paths, so no build-machine
    # path ends up in the binaries (e.g. via __FILE__ in assertions).
    proc = subprocess.run(["./configure", *CONFIGURE_FLAGS], cwd=src, env=env, capture_output=True, text=True)
    (WORK / "configure.log").write_text(proc.stdout + proc.stderr)
    if proc.returncode != 0:
        fail(f"configure failed — see {WORK / 'configure.log'} and {src / 'ffbuild/config.log'}")
    jobs = str(os.cpu_count() or 4)
    log(f"building (make -j{jobs})")
    proc = subprocess.run(["/usr/bin/make", f"-j{jobs}", *TOOLS], cwd=src, env=env, capture_output=True, text=True)
    (WORK / "build.log").write_text(proc.stdout + proc.stderr)
    if proc.returncode != 0:
        fail(f"build failed — see {WORK / 'build.log'}")
    # Any API newer than the deployment target used without an availability
    # check would crash on older macOS: refuse to ship that.
    unguarded = sorted({ln for ln in (proc.stdout + proc.stderr).splitlines() if "only available on macOS" in ln})
    if unguarded:
        fail("build uses APIs newer than macOS " + DEPLOYMENT_TARGET + ":\n  " + "\n  ".join(unguarded[:10]))
    return src


def install(src: Path) -> None:
    shutil.rmtree(OUT, ignore_errors=True)
    (OUT / "bin").mkdir(parents=True)
    for tool in TOOLS:
        dest = OUT / "bin" / tool
        shutil.copy2(src / tool, dest)
        dest.chmod(0o755)
        run("/usr/bin/strip", "-x", str(dest))
        run("/usr/bin/codesign", "--force", "--sign", "-", str(dest))


def verify() -> dict:
    env = {"PATH": CLEAN_PATH, "HOME": os.environ.get("HOME", "/")}
    home = os.environ.get("HOME", "")
    info: dict = {}
    for tool in TOOLS:
        exe = OUT / "bin" / tool
        archs = run("/usr/bin/lipo", "-archs", str(exe)).stdout.split()
        if archs != [ARCH]:
            fail(f"{tool} is {archs}, expected [{ARCH}]")
        minos = macos_minimum(run("/usr/bin/otool", "-l", str(exe)).stdout)
        if not minos or version_tuple(minos) > version_tuple(DEPLOYMENT_TARGET):
            fail(f"{tool} requires macOS {minos}, expected <= {DEPLOYMENT_TARGET}")
        linked = [ln.strip().split(" (compatibility")[0] for ln in run("/usr/bin/otool", "-L", str(exe)).stdout.splitlines()[1:]]
        foreign = [d for d in linked if not d.startswith(SYSTEM_PREFIXES)]
        if foreign:
            fail(f"{tool} links non-system libraries: {foreign}")
        if "LC_RPATH" in run("/usr/bin/otool", "-l", str(exe)).stdout:
            fail(f"{tool} has an rpath")
        blob = exe.read_bytes()
        for marker in (b"/opt/homebrew", b"/usr/local/lib", b"/usr/local/opt", home.encode() if home else None):
            if marker and marker in blob:
                fail(f"{tool} contains a build-machine path ({marker.decode()})")
        proc = subprocess.run(
            [str(exe), "-hide_banner", "-version"], capture_output=True, text=True,
            env={**env, "DYLD_PRINT_LIBRARIES": "1"},
        )
        if proc.returncode != 0:
            fail(f"{tool} -version failed: {proc.stderr[-500:]}")
        loaded = [ln.rsplit("> ", 1)[-1].strip() for ln in proc.stderr.splitlines() if ln.startswith("dyld[")]
        outside = [p for p in loaded if p.startswith("/") and not p.startswith((str(OUT),) + SYSTEM_PREFIXES)]
        if outside:
            fail(f"{tool} loaded images from outside the OS: {outside[:5]}")
        info[tool] = {"minos": minos, "arch": ARCH, "linked": linked, "version": proc.stdout.splitlines()[0]}

    ffmpeg = str(OUT / "bin" / "ffmpeg")
    license_text = run(ffmpeg, "-hide_banner", "-L", env=env).stdout
    buildconf = run(ffmpeg, "-hide_banner", "-buildconf", env=env).stdout
    problems = licence_problems(license_text, buildconf)
    if problems:
        fail("licence check failed: " + "; ".join(problems))
    for kind, wanted in REQUIRED.items():
        have = component_names(run(ffmpeg, "-hide_banner", f"-{kind}", env=env).stdout)
        missing = [w for w in wanted if w not in have]
        if missing:
            fail(f"missing {kind}: {missing}")
    encoders = component_names(run(ffmpeg, "-hide_banner", "-encoders", env=env).stdout)
    present = [e for e in ABSENT_ENCODERS if e in encoders]
    if present:
        fail(f"third-party encoders present: {present}")
    info["license"] = license_text
    info["buildconf"] = buildconf
    return info


NOTICE = """\
FFmpeg in Assistant Editor AI
=============================

This application includes the FFmpeg command-line programs `ffmpeg` and
`ffprobe` (in Contents/Resources/ffmpeg/bin), version {version}. They are
separate programs that Assistant Editor AI runs; they are not linked into the
application.

FFmpeg is free software licensed under the GNU Lesser General Public License,
version 2.1 or (at your option) any later version — see COPYING.LGPLv2.1 and
LICENSE.md in this folder. This build contains only FFmpeg's own code: it was
configured without --enable-gpl, --enable-version3 or --enable-nonfree and with
no external codec libraries. FFmpeg is a trademark of Fabrice Bellard,
originator of the FFmpeg project.

Corresponding source
--------------------
Source:  {url}
SHA-256: {sha256}
Built unmodified (no patches) with the configuration below on macOS for
{arch}, minimum macOS {target}, by scripts/prepare-ffmpeg.py from the
Assistant Editor AI release this copy came with. Configure flags:

{flags}

`ffmpeg -buildconf` (in buildconf.txt) reports the configuration as built.
"""


def write_notices(src: Path, info: dict) -> None:
    licences = OUT / "LICENSES"
    licences.mkdir()
    for name in ("COPYING.LGPLv2.1", "LICENSE.md", "CREDITS"):
        if (src / name).exists():
            shutil.copy2(src / name, licences / name)
    (licences / "buildconf.txt").write_text(info["buildconf"])
    (licences / "ffmpeg-L.txt").write_text(info["license"])
    (licences / "NOTICE.md").write_text(
        NOTICE.format(
            version=FFMPEG_VERSION, url=SOURCE_URL, sha256=SOURCE_SHA256, arch=ARCH,
            target=DEPLOYMENT_TARGET, flags="\n".join(f"    {f}" for f in CONFIGURE_FLAGS),
        )
    )
    (OUT / "SOURCE.txt").write_text(
        f"ffmpeg {FFMPEG_VERSION} built from {SOURCE_URL}\n"
        f"sha256: {SOURCE_SHA256}\n"
        f"arch: {ARCH}\nmacOS minimum (verified from binaries): "
        + ", ".join(f"{t} {info[t]['minos']}" for t in TOOLS)
        + "\nlicence: LGPL v2.1 or later (see LICENSES/)\n"
    )


def main() -> None:
    if sys.platform != "darwin" or os.uname().machine != ARCH:
        fail(f"must run on macOS {ARCH}.")
    tarball = fetch_source()
    src = build(tarball)
    install(src)
    info = verify()
    write_notices(src, info)
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    for tool in TOOLS:
        log(f"{tool}: {info[tool]['version']} — {ARCH}, macOS {info[tool]['minos']}+, links only the OS")
    log(f"LGPL build verified, {size / 1e6:.1f} MB -> {OUT}")


if __name__ == "__main__":
    main()
