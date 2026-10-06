#!/usr/bin/env bash
# Builds the packaged Assistant Editor worker: a PyInstaller one-directory bundle
# (dist-worker/assistant-editor-worker/) that runs without any system Python.
# electron-builder copies it into the app as Resources/worker (package.json
# "extraResources"); electron/worker-supervisor.cjs launches it.
#
#   npm run worker:build
#
# Dependencies come from worker/requirements.txt (the source of truth) into an
# isolated build venv (.build/worker-venv) — never the developer's site-packages.
# Override the interpreter with ASSISTANT_EDITOR_BUILD_PYTHON=/path/to/python3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${ASSISTANT_EDITOR_BUILD_PYTHON:-python3}"
NAME="assistant-editor-worker"
VENV="$ROOT/.build/worker-venv"
WORK="$ROOT/.build/pyinstaller"
OUT="$ROOT/dist-worker"
PYINSTALLER_SPEC="pyinstaller>=6.10,<7"

host_arch="$(uname -m)"
py_arch="$("$PYTHON" -c 'import platform; print(platform.machine())')"
if [[ "$py_arch" != "$host_arch" ]]; then
  echo "build-worker: $PYTHON runs as $py_arch but this Mac is $host_arch — use a native interpreter." >&2
  exit 1
fi

# (Re)create the build venv when missing or built from a different interpreter.
want="$("$PYTHON" -c 'import sys; print(sys.executable, sys.version.split()[0])')"
if [[ ! -x "$VENV/bin/python" || "$(cat "$VENV/.built-from" 2>/dev/null)" != "$want" ]]; then
  rm -rf "$VENV"
  "$PYTHON" -m venv "$VENV"
  echo "$want" > "$VENV/.built-from"
fi
"$VENV/bin/python" -m pip install --quiet --disable-pip-version-check -r "$ROOT/worker/requirements.txt" "$PYINSTALLER_SPEC"

rm -rf "$OUT" "$WORK"
mkdir -p "$OUT"
(
  cd "$ROOT/worker"
  # Provider SDKs and numpy are imported inside functions (lazily) — name them
  # explicitly so the bundle never depends on PyInstaller's import scan alone.
  "$VENV/bin/python" -m PyInstaller server.py \
    --name "$NAME" --onedir --console --noconfirm --clean --log-level WARN \
    --distpath "$OUT" --workpath "$WORK" --specpath "$WORK" \
    --paths "$ROOT/worker" \
    --hidden-import providers.anthropic_provider \
    --hidden-import providers.openai_provider \
    --hidden-import anthropic --hidden-import openai --hidden-import numpy \
    --exclude-module tests --exclude-module validate_e2e --exclude-module tkinter
)

EXE="$OUT/$NAME/$NAME"
# The frozen worker must import everything it needs with NO system Python on
# PATH and no access to the developer's site-packages.
env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin" ASSISTANT_EDITOR_SKIP_DOTENV=1 \
  "$EXE" --selftest > "$OUT/selftest.json"

{
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "arch: $host_arch"
  echo "python: $want"
  echo "--- resolved packages (pip freeze) ---"
  "$VENV/bin/python" -m pip freeze --disable-pip-version-check
} > "$OUT/build-manifest.txt"

echo "build-worker: $EXE ($(du -sh "$OUT/$NAME" | cut -f1)) — selftest passed, see dist-worker/selftest.json"
