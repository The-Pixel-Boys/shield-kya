#!/usr/bin/env python3
"""Package the Shield KYA Splunk app as dist/shield_kya-<version>.tgz (a .spl is the same tar.gz).

Usage: python3 build.py [out-dir]

Python stdlib only. The tarball has one root folder (shield_kya/), sorted entries, uid/gid 0,
mode 0644 for files and 0755 for folders, and no hidden files, no local/ folder and no .pyc files.
macOS tar adds ._* AppleDouble files and extended attributes, which Splunkbase refuses; tarfile does not.
"""
import configparser
import gzip
import io
import os
import sys
import tarfile


def need(ok, msg):
    """A package rule. sys.exit, not assert, so that python3 -O keeps the check."""
    if not ok:
        sys.exit(f"build.py: {msg}")


HERE = os.path.dirname(os.path.abspath(__file__))
APP = "shield_kya"
SRC = os.path.join(HERE, APP)


def app_version():
    conf = configparser.ConfigParser(interpolation=None)
    conf.read(os.path.join(SRC, "default", "app.conf"))
    need(conf["package"]["id"] == APP, "app.conf [package] id must equal the folder name")
    label = conf["ui"]["label"]
    need(5 <= len(label) <= 80, "app.conf [ui] label must have 5 to 80 characters")
    version = conf["launcher"]["version"]
    need(version == conf["id"]["version"], "[launcher] version and [id] version must be the same")
    return version


def files():
    out = []
    for root, dirs, names in os.walk(SRC):
        dirs.sort()
        rel_root = os.path.relpath(root, HERE)
        for d in dirs:
            need(not d.startswith("."), f"hidden folder: {os.path.join(rel_root, d)}")
            need(not (root == SRC and d == "local"), "the app must not ship a local/ folder")
        for n in sorted(names):
            need(not n.startswith("."), f"hidden file: {os.path.join(rel_root, n)}")
            need(not n.endswith((".pyc", ".pyo")), f"compiled Python: {n}")
            out.append(os.path.join(root, n))
    return out


def build(out_dir):
    version = app_version()
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, f"{APP}-{version}.tgz")
    paths = files()
    folders = sorted({os.path.dirname(p) for p in paths} | {SRC})
    # Add every parent folder so each one has its own entry with mode 0755.
    for p in list(folders):
        while p != SRC:
            p = os.path.dirname(p)
            folders.append(p)
    buf = io.BytesIO()
    # mtime 0 in the gzip header and fixed tar metadata: the same tree gives the same bytes.
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0) as gz, tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for d in sorted(set(folders)):
            info = tarfile.TarInfo(os.path.relpath(d, HERE))
            info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, 0
            tar.addfile(info)
        for p in paths:
            info = tarfile.TarInfo(os.path.relpath(p, HERE))
            info.size, info.mode, info.mtime = os.path.getsize(p), 0o644, 0
            with open(p, "rb") as f:
                tar.addfile(info, f)
    with open(target, "wb") as f:
        f.write(buf.getvalue())
    check(target)
    return target


def check(target):
    """The tarball rules Splunkbase package validation applies, checked on the output."""
    with tarfile.open(target) as tar:
        names = tar.getnames()
        need(names and all(n == APP or n.startswith(APP + "/") for n in names), "one root folder only")
        for m in tar.getmembers():
            base = os.path.basename(m.name)
            need(not base.startswith("."), f"hidden entry {m.name}")
            need(m.uid == 0 and m.gid == 0, f"owner of {m.name}")
            need(m.mode == (0o755 if m.isdir() else 0o644), f"mode of {m.name}")
            need(m.isdir() or m.isfile(), f"links are not allowed: {m.name}")
        need(f"{APP}/local" not in names, "no local/ folder")
        for required in ("default/app.conf", "README.md", "LICENSE", "metadata/default.meta"):
            need(f"{APP}/{required}" in names, f"missing {required}")


if __name__ == "__main__":
    print(build(os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "dist"))))
