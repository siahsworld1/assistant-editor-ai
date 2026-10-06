#!/usr/bin/env bash
# Builds the packaged Assistant Editor worker: a PyInstaller one-directory bundle
# (dist-worker/assistant-editor-worker/) that runs without any system Python.
# electron-builder copies it into the app as Resources/worker (package.json
# "extraResources"); electron/worker-supervisor.cjs launches it.
#
#   npm run worker:build
#
# The interpreter and every package come from scripts/worker-python.sh: the
# pinned CPython 3.12 and the hash-locked worker/requirements.lock (plus the
# build-only worker/requirements-build.lock for PyInstaller) — the same Python
# and package versions the dev worker and the worker tests use. The shell's
# python3, Homebrew and the developer's site-packages are never involved; if the
# pinned environment can't be created exactly, the build stops.
#
# After building, the frozen worker itself is verified: it must report the
# pinned Python version, contain exactly the locked package versions, be arm64
# only, need no newer macOS than MACOS_MINIMUM, and load nothing from outside
# the bundle and the OS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="assistant-editor-worker"
WORK="$ROOT/.build/pyinstaller"
OUT="$ROOT/dist-worker"
MACOS_MINIMUM="14.0"

PY="$("$ROOT/scripts/worker-python.sh" build)"
PY_PINNED="$("$ROOT/scripts/worker-python.sh" python)"
PY_VERSION="$("$PY" -I -c 'import platform; print(platform.python_version())')"
[[ "$PY_VERSION" == 3.12.* ]] || { echo "build-worker: expected Python 3.12, got $PY_VERSION" >&2; exit 1; }

# Every locked distribution's metadata goes into the bundle, so the frozen
# worker can report (and this script can verify) exactly what it contains.
metadata_args=()
while read -r dist; do metadata_args+=(--copy-metadata "$dist"); done < <(
  sed -nE 's/^([A-Za-z0-9._-]+)==.*/\1/p' "$ROOT/worker/requirements.lock")

exclude_args=(
  --exclude-module tests --exclude-module validate_e2e --exclude-module tkinter
  # Build tools never run in the worker. flask.cli's Python<3.10 fallback
  # `import importlib_metadata` would otherwise resolve to setuptools' vendored
  # copy and drag setuptools into the bundle.
  --exclude-module setuptools --exclude-module pkg_resources --exclude-module _distutils_hack
)

rm -rf "$OUT" "$WORK"
mkdir -p "$OUT"
(
  cd "$ROOT/worker"
  # Provider SDKs and numpy are imported inside functions (lazily) — name them
  # explicitly so the bundle never depends on PyInstaller's import scan alone.
  "$PY" -I -m PyInstaller server.py \
    --name "$NAME" --onedir --console --noconfirm --clean --log-level WARN \
    --distpath "$OUT" --workpath "$WORK" --specpath "$WORK" \
    --paths "$ROOT/worker" \
    --hidden-import providers.anthropic_provider \
    --hidden-import providers.openai_provider \
    --hidden-import anthropic --hidden-import openai --hidden-import numpy \
    "${metadata_args[@]}" \
    "${exclude_args[@]}"
)

EXE="$OUT/$NAME/$NAME"
# The frozen worker must import everything it needs with NO system Python on
# PATH and no access to the developer's site-packages.
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" ASSISTANT_EDITOR_SKIP_DOTENV=1 \
  "$EXE" --selftest > "$OUT/selftest.json"

"$PY" -I - "$OUT/$NAME" "$OUT/selftest.json" "$ROOT/worker/requirements.lock" "$PY_VERSION" "$MACOS_MINIMUM" "$ROOT" "$HOME" <<'EOF'
import json, re, subprocess, sys
from pathlib import Path

bundle, selftest, lock, py_version, minimum, repo, home = sys.argv[1:]
bundle, report = Path(bundle), json.loads(Path(selftest).read_text())
problems = []

def norm(name): return re.sub(r"[-_.]+", "-", name).lower()

if report["python"] != py_version:
    problems.append(f"frozen worker reports Python {report['python']}, built with {py_version}")
if report["arch"] != "arm64":
    problems.append(f"frozen worker runs as {report['arch']}")
bad = {k: v for k, v in report["modules"].items() if str(v).startswith("MISSING")}
if bad:
    problems.append(f"modules missing: {bad}")
locked = {norm(m[1]): m[2] for m in re.finditer(r"^([A-Za-z0-9._-]+)==(\S+)", Path(lock).read_text(), re.M)}
shipped = report["distributions"]
for name, version in locked.items():
    if shipped.get(name) != version:
        problems.append(f"{name}: locked {version}, bundled {shipped.get(name)}")
for name in sorted(set(shipped) - set(locked)):
    problems.append(f"{name} {shipped[name]} is bundled but not in the production lock")

def minos(path):
    out = subprocess.run(["/usr/bin/otool", "-l", str(path)], capture_output=True, text=True).stdout.splitlines()
    for i, line in enumerate(out):
        if line.strip() in ("cmd LC_BUILD_VERSION", "cmd LC_VERSION_MIN_MACOSX"):
            for follow in out[i + 1 : i + 6]:
                parts = follow.split()
                if parts and parts[0] in ("minos", "version"):
                    return parts[1]
    return None

def ver(v): return tuple(int(x) for x in v.split("."))

machos = 0
for f in sorted(p for p in bundle.rglob("*") if p.is_file() and not p.is_symlink()):
    with open(f, "rb") as fh:
        if fh.read(4) not in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
            continue
    machos += 1
    rel = f.relative_to(bundle)
    archs = subprocess.run(["/usr/bin/lipo", "-archs", str(f)], capture_output=True, text=True).stdout.split()
    if archs != ["arm64"]:
        problems.append(f"{rel}: architectures {archs}")
    m = minos(f)
    if m is None or ver(m) > ver(minimum):
        problems.append(f"{rel}: requires macOS {m} (> {minimum})")
    for line in subprocess.run(["/usr/bin/otool", "-L", str(f)], capture_output=True, text=True).stdout.splitlines()[1:]:
        dep = line.strip().split(" (compatibility")[0]
        if not dep.startswith(("@rpath/", "@loader_path/", "@executable_path/", "/usr/lib/", "/System/Library/")):
            problems.append(f"{rel}: links {dep}")
    # Build-machine paths (linkage is checked above; generic text such as
    # Python's own docstrings mentioning /usr/local is not a dependency).
    blob = f.read_bytes()
    for marker in ("/opt/homebrew", "/Library/Developer/CommandLineTools", repo, home):
        if marker.encode() in blob:
            problems.append(f"{rel}: contains {marker}")

if problems:
    print("build-worker: verification FAILED:\n  " + "\n  ".join(problems[:40]), file=sys.stderr)
    sys.exit(1)
print(f"build-worker: verified Python {py_version}, {len(locked)} locked packages, {machos} Mach-O files arm64 / macOS <= {minimum}, OS-only linkage")
EOF

{
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "arch: $(uname -m)"
  echo "python: CPython $PY_VERSION ($(basename "$(dirname "$(dirname "$PY_PINNED")")"))"
  echo "requirements.lock sha256: $(shasum -a 256 "$ROOT/worker/requirements.lock" | cut -d' ' -f1)"
  echo "requirements-build.lock sha256: $(shasum -a 256 "$ROOT/worker/requirements-build.lock" | cut -d' ' -f1)"
  echo "--- installed in the build environment (pip freeze) ---"
  "$PY" -I -m pip freeze --disable-pip-version-check
} > "$OUT/build-manifest.txt"

echo "build-worker: $EXE ($(du -sh "$OUT/$NAME" | cut -f1)) — selftest passed, see dist-worker/selftest.json"
