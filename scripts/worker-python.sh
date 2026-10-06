#!/usr/bin/env bash
# The worker's Python: one pinned CPython 3.12 and one hash-locked dependency
# set, used to develop, test AND package the worker — so what we validate is
# exactly what ships.
#
#   scripts/worker-python.sh dev      worker/.venv: dev worker + worker tests
#                                     (Electron's dev mode already prefers it)
#   scripts/worker-python.sh build    .build/worker-venv: production lock + build
#                                     tools; used by scripts/build-worker.sh
#   scripts/worker-python.sh lock     re-resolve worker/requirements*.txt into the
#                                     hash-pinned worker/requirements*.lock
#   scripts/worker-python.sh python   print the pinned interpreter's path
#
# The interpreter is a relocatable CPython build from python-build-standalone
# (the builds uv and others use), downloaded into .build/python/ and verified
# against a pinned SHA-256. Neither /usr/bin/python3, Homebrew nor whatever
# python3 is first on PATH is ever used. Installs come only from the locks
# (--require-hashes, binary wheels only, no dependency resolution), so a
# missing or mismatched package fails the install instead of being swapped.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_VERSION="3.12.15"
PBS_RELEASE="20261003"
PBS_ASSET="cpython-${PY_VERSION}+${PBS_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${PBS_ASSET//+/%2B}"
PBS_SHA256="316a463172740e71d8dca1f2730784e325f3f720941137b5d674d5801a632213"
PIP_TOOLS="pip-tools==7.6.1"

PY_HOME="$ROOT/.build/python/cpython-${PY_VERSION}+${PBS_RELEASE}"
PYTHON="$PY_HOME/bin/python3"
LOCK="$ROOT/worker/requirements.lock"
BUILD_LOCK="$ROOT/worker/requirements-build.lock"

die() { echo "worker-python: $*" >&2; exit 1; }

# Nothing from the user's shell may steer pip or Python.
unset PYTHONPATH PYTHONHOME PYTHONSTARTUP PYTHONUSERBASE PIP_INDEX_URL PIP_EXTRA_INDEX_URL PIP_REQUIRE_VIRTUALENV PIP_CONFIG_FILE VIRTUAL_ENV

provision() {
  [[ "$(uname -s)/$(uname -m)" == "Darwin/arm64" ]] || die "requires macOS on Apple silicon (arm64)."
  if [[ ! -x "$PYTHON" ]]; then
    local cache="$ROOT/.build/python/$PBS_ASSET"
    mkdir -p "$ROOT/.build/python"
    if [[ ! -f "$cache" ]]; then
      echo "worker-python: downloading CPython $PY_VERSION ($PBS_RELEASE)" >&2
      curl -fsSL --retry 3 -o "$cache.partial" "$PBS_URL" || die "download failed: $PBS_URL"
      mv "$cache.partial" "$cache"
    fi
    local got
    got="$(shasum -a 256 "$cache" | cut -d' ' -f1)"
    [[ "$got" == "$PBS_SHA256" ]] || { rm -f "$cache"; die "$PBS_ASSET SHA-256 $got != pinned $PBS_SHA256 (deleted)"; }
    rm -rf "$PY_HOME" "$PY_HOME.partial"
    mkdir -p "$PY_HOME.partial"
    tar -xzf "$cache" -C "$PY_HOME.partial" --strip-components 1
    mv "$PY_HOME.partial" "$PY_HOME"
  fi
  local actual
  actual="$("$PYTHON" -I -c 'import platform, sys; print(platform.python_version(), platform.machine())')"
  [[ "$actual" == "$PY_VERSION arm64" ]] || die "pinned interpreter reports '$actual', expected '$PY_VERSION arm64'"
}

# make_venv DIR LOCK... — (re)creates DIR from the pinned interpreter and the
# given locks, unless it already matches them exactly (stamp check).
make_venv() {
  local dir="$1"; shift
  local lock stamp
  for lock in "$@"; do [[ -f "$lock" ]] || die "missing $lock — run: scripts/worker-python.sh lock"; done
  stamp="$(cat "$@" | shasum -a 256 | cut -d' ' -f1) $PY_VERSION+$PBS_RELEASE"
  if [[ -x "$dir/bin/python" && "$(cat "$dir/.ae-lock-stamp" 2>/dev/null)" == "$stamp" ]]; then
    return 0
  fi
  echo "worker-python: creating $dir (Python $PY_VERSION, from ${*##*/})" >&2
  rm -rf "$dir"
  "$PYTHON" -I -m venv "$dir"
  local args=()
  for lock in "$@"; do args+=(-r "$lock"); done
  "$dir/bin/python" -I -m pip install --isolated --quiet --disable-pip-version-check --no-cache-dir \
    --require-hashes --no-deps --only-binary=:all: "${args[@]}"
  "$dir/bin/python" -I -m pip check --disable-pip-version-check >/dev/null || die "$dir: inconsistent dependencies ($("$dir/bin/python" -I -m pip check | head -3))"
  echo "$stamp" > "$dir/.ae-lock-stamp"
}

lock() {
  local tools="$ROOT/.build/lock-tools"
  if [[ ! -x "$tools/bin/pip-compile" ]]; then
    rm -rf "$tools"
    "$PYTHON" -I -m venv "$tools"
    "$tools/bin/python" -I -m pip install --isolated --quiet --disable-pip-version-check "$PIP_TOOLS"
  fi
  local common=(--quiet --generate-hashes --allow-unsafe --strip-extras --no-emit-index-url
    --no-emit-trusted-host --resolver=backtracking --newline=lf)
  (cd "$ROOT/worker" &&
    "$tools/bin/pip-compile" "${common[@]}" --output-file requirements.lock requirements.txt &&
    "$tools/bin/pip-compile" "${common[@]}" --output-file requirements-build.lock requirements-build.txt)
  echo "worker-python: wrote worker/requirements.lock and worker/requirements-build.lock" >&2
}

provision
case "${1:-}" in
  dev) make_venv "$ROOT/worker/.venv" "$LOCK"; echo "$ROOT/worker/.venv/bin/python" ;;
  build) make_venv "$ROOT/.build/worker-venv" "$LOCK" "$BUILD_LOCK"; echo "$ROOT/.build/worker-venv/bin/python" ;;
  lock) lock ;;
  python) echo "$PYTHON" ;;
  *) die "usage: scripts/worker-python.sh dev|build|lock|python" ;;
esac
