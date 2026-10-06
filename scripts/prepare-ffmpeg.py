#!/usr/bin/env python3
"""Prepares self-contained ffmpeg/ffprobe for the packaged macOS app.

    npm run ffmpeg:prepare

Copies ffmpeg + ffprobe and their complete non-system dylib dependency tree into
dist-ffmpeg/ (bin/ + lib/), rewrites every load path to @loader_path so nothing
references the build machine (e.g. /opt/homebrew), ad-hoc re-signs each Mach-O
(required on Apple silicon after editing load commands), then VERIFIES the
result by actually running both tools and checking every image the dynamic
loader loads is inside dist-ffmpeg/ or the OS. electron-builder copies the
folder into the app as Resources/ffmpeg (package.json "extraResources").

Source: the ffmpeg/ffprobe on PATH (this project validated real footage with
Homebrew's ffmpeg), or a directory given by ASSISTANT_EDITOR_FFMPEG_SOURCE.
Its licence files and build configuration are copied alongside.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist-ffmpeg"
TOOLS = ("ffmpeg", "ffprobe")
SYSTEM_PREFIXES = ("/usr/lib/", "/System/")
CLEAN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


def fail(msg: str) -> None:
    print(f"prepare-ffmpeg: {msg}", file=sys.stderr)
    sys.exit(1)


def run(*args: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw)


def source_tool(tool: str) -> Path:
    src_dir = os.environ.get("ASSISTANT_EDITOR_FFMPEG_SOURCE")
    found = str(Path(src_dir) / tool) if src_dir else shutil.which(tool)
    if not found or not Path(found).exists():
        fail(f"{tool} not found (install ffmpeg, or set ASSISTANT_EDITOR_FFMPEG_SOURCE).")
    return Path(os.path.realpath(found))


def load_commands(path: Path) -> list[str]:
    """Libraries `path` links against (excluding its own install id)."""
    lines = run("otool", "-L", str(path)).stdout.splitlines()[1:]
    deps = [line.strip().split(" (compatibility")[0] for line in lines]
    own_id = run("otool", "-D", str(path)).stdout.splitlines()[1:]
    return [d for d in deps if d not in own_id]


def rpaths(path: Path) -> list[str]:
    out, lines = [], run("otool", "-l", str(path)).stdout.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "cmd LC_RPATH":
            out.append(lines[i + 2].strip().split(" ", 1)[1].rsplit(" (offset", 1)[0])
    return out


def resolve(dep: str, referrer: Path) -> Path:
    if dep.startswith("@loader_path/") or dep.startswith("@executable_path/"):
        return Path(os.path.realpath(referrer.parent / dep.split("/", 1)[1]))
    if dep.startswith("@rpath/"):
        for rp in rpaths(referrer):
            base = rp.replace("@loader_path", str(referrer.parent)).replace("@executable_path", str(referrer.parent))
            candidate = Path(base) / dep.split("/", 1)[1]
            if candidate.exists():
                return Path(os.path.realpath(candidate))
        fail(f"cannot resolve {dep} referenced by {referrer}")
    return Path(os.path.realpath(dep))


def main() -> None:
    if sys.platform != "darwin":
        fail("macOS only.")
    sources = {tool: source_tool(tool) for tool in TOOLS}

    # 1. Dependency closure (non-system dylibs), keyed by bundle file name.
    libs: dict[str, Path] = {}
    queue = list(sources.values())
    seen: set[Path] = set()
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        for dep in load_commands(current):
            if dep.startswith(SYSTEM_PREFIXES):
                continue
            real = resolve(dep, current)
            name = Path(dep).name
            if name in libs and libs[name] != real:
                fail(f"two different libraries are both named {name}: {libs[name]} and {real}")
            libs[name] = real
            queue.append(real)

    # 2. Copy into a fresh dist-ffmpeg/{bin,lib}.
    shutil.rmtree(OUT, ignore_errors=True)
    (OUT / "bin").mkdir(parents=True)
    (OUT / "lib").mkdir()
    copied: list[Path] = []
    for name, src in sorted(libs.items()):
        dest = OUT / "lib" / name
        shutil.copy2(src, dest)
        dest.chmod(0o755)
        copied.append(dest)
    for tool, src in sources.items():
        dest = OUT / "bin" / tool
        shutil.copy2(src, dest)
        dest.chmod(0o755)
        copied.append(dest)

    # 3. Rewrite load paths to the bundle, drop build-machine rpaths, re-sign.
    for f in copied:
        in_bin = f.parent.name == "bin"
        args: list[str] = []
        if not in_bin:
            args += ["-id", f"@rpath/{f.name}"]
        for dep in load_commands(f):
            if dep.startswith(SYSTEM_PREFIXES):
                continue
            target = f"@loader_path/../lib/{Path(dep).name}" if in_bin else f"@loader_path/{Path(dep).name}"
            args += ["-change", dep, target]
        for rp in rpaths(f):
            args += ["-delete_rpath", rp]
        if args:
            run("install_name_tool", *args, str(f))
    for f in [p for p in copied if p.parent.name == "lib"] + [p for p in copied if p.parent.name == "bin"]:
        run("codesign", "--force", "--sign", "-", str(f))

    # 4. Verify: no reference to anything outside the bundle or the OS ...
    for f in copied:
        for dep in load_commands(f):
            if not (dep.startswith(SYSTEM_PREFIXES) or dep.startswith("@loader_path/") or dep.startswith("@rpath/")):
                fail(f"{f.relative_to(OUT)} still references {dep}")
        if rpaths(f):
            fail(f"{f.relative_to(OUT)} still has rpaths {rpaths(f)}")
    # ... and both tools really run, loading ONLY bundled or OS images, with no
    # Homebrew on PATH and no inherited DYLD_* settings.
    versions = {}
    for tool in TOOLS:
        exe = OUT / "bin" / tool
        proc = subprocess.run(
            [str(exe), "-version"], capture_output=True, text=True,
            env={"PATH": CLEAN_PATH, "DYLD_PRINT_LIBRARIES": "1", "HOME": os.environ.get("HOME", "/")},
        )
        if proc.returncode != 0:
            fail(f"{tool} -version failed: {proc.stderr[-500:]}")
        loaded = [ln.split("dyld[", 1)[-1].split("]: <", 1)[-1].split("> ", 1)[-1].strip() for ln in proc.stderr.splitlines() if "dyld" in ln]
        loaded = [p for p in loaded if p.startswith("/")]
        foreign = [p for p in loaded if not (p.startswith(str(OUT)) or p.startswith(SYSTEM_PREFIXES))]
        if foreign:
            fail(f"{tool} loaded images from outside the bundle: {foreign[:5]}")
        versions[tool] = proc.stdout.splitlines()[0]

    # 5. Licence + build configuration travel with the binaries.
    licences = OUT / "LICENSES"
    licences.mkdir()
    cellar = sources["ffmpeg"].parent.parent
    for candidate in ("LICENSE.md", "COPYING.GPLv2", "COPYING.GPLv3", "COPYING.LGPLv2.1", "COPYING.LGPLv3"):
        if (cellar / candidate).exists():
            shutil.copy2(cellar / candidate, licences / candidate)
    buildconf = subprocess.run([str(OUT / "bin" / "ffmpeg"), "-hide_banner", "-buildconf"], capture_output=True, text=True, env={"PATH": CLEAN_PATH})
    (licences / "ffmpeg-buildconf.txt").write_text(buildconf.stdout)
    (OUT / "SOURCE.txt").write_text(
        "".join(f"{tool}: {src}\n" for tool, src in sources.items())
        + "".join(f"{tool} version: {v}\n" for tool, v in versions.items())
        + f"bundled libraries: {len(libs)}\n"
    )

    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    for tool, v in versions.items():
        print(f"prepare-ffmpeg: {tool}: {v}")
    print(f"prepare-ffmpeg: {len(libs)} libraries relocated, {size / 1e6:.0f} MB, verified self-contained -> {OUT}")


if __name__ == "__main__":
    main()
