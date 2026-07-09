#!/usr/bin/env python3
"""Stage scenario (game data) directories for the web build.

Usage: package_scenarios.py OUT_DIR SCENARIO_DIR...

For each scenario directory (a checkout of one of the data-marathon*
submodules under data/Scenarios/), mirror its files into OUT_DIR/<slug>/
and write OUT_DIR/<slug>/manifest.json listing every file with its size.
The browser shell fetches the manifest and then the files, so the game
data is downloaded per-scenario instead of preloaded into one big bundle.

Copies are skipped when size+mtime match; files that disappeared from the
source are removed, so the staging dir tracks the submodule exactly.
"""

import json
import os
import shutil
import sys

SLUGS = {
    "Marathon": "marathon",
    "Marathon 2": "marathon2",
    "Marathon Infinity": "infinity",
}

SKIP_NAMES = {".git", ".DS_Store"}


def stage(src_dir, out_root):
    name = os.path.basename(src_dir.rstrip("/"))
    slug = SLUGS.get(name, name.lower().replace(" ", "-"))
    dest_root = os.path.join(out_root, slug)

    files = []
    wanted = set()
    for root, dirs, names in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in SKIP_NAMES]
        for fname in names:
            if fname in SKIP_NAMES:
                continue
            src = os.path.join(root, fname)
            rel = os.path.relpath(src, src_dir)
            dest = os.path.join(dest_root, rel)
            wanted.add(os.path.normpath(rel))

            st = os.stat(src)
            try:
                dt = os.stat(dest)
                up_to_date = dt.st_size == st.st_size and dt.st_mtime >= st.st_mtime
            except FileNotFoundError:
                up_to_date = False
            if not up_to_date:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copy2(src, dest)
            files.append({"path": rel.replace(os.sep, "/"), "size": st.st_size})

    # Drop files that no longer exist in the source.
    for root, dirs, names in os.walk(dest_root):
        for fname in names:
            if fname == "manifest.json":
                continue
            rel = os.path.normpath(os.path.relpath(os.path.join(root, fname), dest_root))
            if rel not in wanted:
                os.remove(os.path.join(root, fname))

    files.sort(key=lambda f: f["path"])
    manifest = {
        "name": name,
        "files": files,
        "total": sum(f["size"] for f in files),
    }
    with open(os.path.join(dest_root, "manifest.json"), "w") as fp:
        json.dump(manifest, fp, indent=1)
    return name, slug, len(files), manifest["total"]


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out_root = sys.argv[1]
    staged = 0
    for src_dir in sys.argv[2:]:
        if not os.path.isdir(src_dir) or not any(
            e not in SKIP_NAMES for e in os.listdir(src_dir)
        ):
            print(f"scenario skipped (empty; run 'git submodule update --init' "
                  f"or wasm/fetch-deps.sh): {src_dir}", file=sys.stderr)
            continue
        name, slug, nfiles, total = stage(src_dir, out_root)
        print(f"scenario staged: {name} -> {slug} ({nfiles} files, {total/1e6:.1f} MB)")
        staged += 1
    if not staged:
        sys.exit("error: no scenario data found; run wasm/fetch-deps.sh first")


if __name__ == "__main__":
    main()
