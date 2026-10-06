#!/usr/bin/env python3
"""Extracts the licence texts of the third-party libraries compiled into the
packaged worker's Python runtime (libpython3.12.dylib) into licenses/python-runtime/,
from the SAME pinned build, verified by checksum:

  - python-build-standalone's full archive of the exact release/version that
    scripts/worker-python.sh pins (it ships python/licenses/LICENSE.<lib>.txt
    for every library it compiles in, and python/PYTHON.json maps them);
  - the CPython source tarball that release builds from (pinned in its
    pythonbuild/downloads.json), for HACL*, whose MIT licence lives in the
    header of each vendored Modules/_hacl source file.

Run after changing the Python pin in scripts/worker-python.sh:

    .build/lock-tools/bin/python scripts/python-runtime-licenses.py

(needs `zstandard` in that venv: `.build/lock-tools/bin/python -m pip install zstandard==0.25.0`).
The extracted texts and PROVENANCE.json are committed; scripts/after-pack.cjs
puts them into the app's acknowledgements.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "licenses" / "python-runtime"
CACHE = ROOT / ".build" / "python"

PBS_RELEASE = "20261003"
PY_VERSION = "3.12.15"
PBS_FULL = f"cpython-{PY_VERSION}+{PBS_RELEASE}-aarch64-apple-darwin-pgo+lto-full.tar.zst"
PBS_FULL_SHA256 = "a23a0baff73a5f10c820841cc1889a5b7fc12048fe8c0622f6a481ab82ea367b"  # release SHA256SUMS
CPYTHON_SRC = f"Python-{PY_VERSION}.tar.xz"
CPYTHON_SRC_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/{CPYTHON_SRC}"
CPYTHON_SRC_SHA256 = "c2c4321961fab0fb999d66e0cecf521c2ab3994c7992873ea99e306c1094fd5a"  # PBS downloads.json pin

# Library -> (PBS licence file, its licence, the python-build-standalone
# downloads.json entry, a libpython extension that proves it is compiled in).
# Licences are named per component: PYTHON.json lists them per *extension*, so
# e.g. _sqlite3 shows "Zlib" because it also links the system zlib.
COMPONENTS = {
    "OpenSSL": ("LICENSE.openssl-3.txt", "Apache-2.0", "openssl-3.5", "_ssl"),
    "SQLite": ("LICENSE.sqlite.txt", "Public domain (blessing)", "sqlite", "_sqlite3"),
    "libffi": ("LICENSE.libffi.txt", "MIT", "libffi", "_ctypes"),
    "Expat": ("LICENSE.expat.txt", "MIT", "expat", "pyexpat"),
    "mpdecimal": ("LICENSE.mpdecimal.txt", "BSD-2-Clause", "mpdecimal", "_decimal"),
    "XZ Utils (liblzma)": ("LICENSE.liblzma.txt", "0BSD", "xz", "_lzma"),
    "bzip2": ("LICENSE.bzip2.txt", "bzip2-1.0.6", "bzip2", "_bz2"),
    "libuuid": ("LICENSE.libuuid.txt", "BSD-3-Clause", "uuid", "_uuid"),
}


def display_version(download: str, version: str) -> str:
    """SQLite's downloads use its 7-digit form (3530100 -> 3.53.1)."""
    if download == "sqlite" and version.isdigit() and len(version) == 7:
        return f"{int(version[0])}.{int(version[1:3])}.{int(version[3:5])}"
    return version


def fail(msg: str) -> None:
    print(f"python-runtime-licenses: {msg}", file=sys.stderr)
    sys.exit(1)


def fetch(name: str, url: str, sha256: str) -> bytes:
    path = CACHE / name
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=300) as resp:
            path.write_bytes(resp.read())
    data = path.read_bytes()
    got = hashlib.sha256(data).hexdigest()
    if got != sha256:
        path.unlink()
        fail(f"{name}: SHA-256 {got} != pinned {sha256} (deleted)")
    return data


def main() -> None:
    pin = (ROOT / "scripts" / "worker-python.sh").read_text()
    for var, value in (("PY_VERSION", PY_VERSION), ("PBS_RELEASE", PBS_RELEASE)):
        if f'{var}="{value}"' not in pin:
            fail(f"scripts/worker-python.sh no longer pins {var}={value}; update this script's pins first.")
    try:
        import zstandard
    except ImportError:
        fail("needs the `zstandard` package (see the module docstring).")

    full = fetch(
        PBS_FULL,
        f"https://github.com/astral-sh/python-build-standalone/releases/download/{PBS_RELEASE}/{PBS_FULL.replace('+', '%2B')}",
        PBS_FULL_SHA256,
    )
    tar = tarfile.open(fileobj=io.BytesIO(zstandard.ZstdDecompressor().stream_reader(io.BytesIO(full)).read()))
    meta = json.load(tar.extractfile("python/PYTHON.json"))
    if meta.get("python_version") != PY_VERSION:
        fail(f"archive is Python {meta.get('python_version')}, expected {PY_VERSION}")
    extensions = meta["build_info"]["extensions"]
    with urllib.request.urlopen(
        f"https://raw.githubusercontent.com/astral-sh/python-build-standalone/{PBS_RELEASE}/pythonbuild/downloads.json",
        timeout=60,
    ) as resp:
        downloads = json.load(resp)
    if downloads["cpython-3.12"]["sha256"] != CPYTHON_SRC_SHA256:
        fail("CPython source pin differs from python-build-standalone's downloads.json")

    OUT.mkdir(parents=True, exist_ok=True)
    provenance = {
        "python": PY_VERSION,
        "pythonBuildStandalone": PBS_RELEASE,
        "sources": {
            PBS_FULL: PBS_FULL_SHA256,
            CPYTHON_SRC: CPYTHON_SRC_SHA256,
        },
        "components": [],
    }
    for name, (licence, spdx, download, extension) in COMPONENTS.items():
        ext = extensions[extension][0]
        if f"licenses/{licence}" not in ext.get("license_paths", []):
            fail(f"{extension} does not cite {licence} in PYTHON.json")
        text = tar.extractfile(f"python/licenses/{licence}").read()
        (OUT / licence).write_bytes(text)
        provenance["components"].append({
            "name": name,
            "version": display_version(download, downloads[download]["version"]),
            "license": spdx,
            "file": licence,
            "from": f"{PBS_FULL}:python/licenses/{licence}",
            "sha256": hashlib.sha256(text).hexdigest(),
        })

    src = tarfile.open(fileobj=io.BytesIO(fetch(CPYTHON_SRC, CPYTHON_SRC_URL, CPYTHON_SRC_SHA256)), mode="r:xz")
    headers = set()
    hacl_dir = f"Python-{PY_VERSION}/Modules/_hacl/"
    for member in src.getmembers():
        if member.name.startswith(hacl_dir) and re.search(r"/Hacl_[^/]+\.[ch]$", member.name):
            m = re.search(r"/\* MIT License.*?\*/", src.extractfile(member).read().decode(), re.S)
            if not m:
                fail(f"{member.name}: no MIT licence header")
            headers.add(m.group(0))
    if len(headers) != 1:
        fail(f"HACL* files carry {len(headers)} different licence headers")
    header = headers.pop()
    text = "\n".join(re.sub(r"^ ?\* ?|^/\* ?| ?\*/$", "", line) for line in header.splitlines()).strip() + "\n"
    rev = re.search(r"expected_hacl_star_rev=(\w+)", src.extractfile(hacl_dir + "refresh.sh").read().decode())
    (OUT / "LICENSE.hacl-star.txt").write_text(text)
    provenance["components"].append({
        "name": "HACL*",
        "version": f"git {rev.group(1)[:12]}" if rev else "",
        "license": "MIT",
        "file": "LICENSE.hacl-star.txt",
        "from": f"{CPYTHON_SRC}:{hacl_dir}Hacl_*.[ch] (licence header)",
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
    })
    (OUT / "PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"python-runtime-licenses: wrote {len(provenance['components'])} licences -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
