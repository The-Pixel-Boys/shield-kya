#!/usr/bin/env bash
# Opt-in: run Splunk AppInspect on the packaged Shield KYA app. Not run in CI (needs podman).
#
#   bash appinspect.sh [out-dir]
#
# Builds dist/shield_kya-<version>.tgz with build.py, then runs AppInspect in a throwaway
# python:3.12-slim container (it needs libmagic, which the container gets from apt). The container
# has no access to this repo: only the tarball and the out folder are mounted.
# Writes <out>/appinspect.json (default checks) and <out>/appinspect-cloud.json (--included-tags cloud).
# Exit 1 when either run reports a failure or an error.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mkdir -p "${1:-$here/dist}" && cd "${1:-$here/dist}" && pwd)"
PYTHON_IMAGE="${PYTHON_IMAGE:-docker.io/library/python:3.12-slim}"
APPINSPECT_VERSION="${APPINSPECT_VERSION:-4.3.1}"

tgz="$(python3 -I "$here/build.py" "$out")"
name="$(basename "$tgz")"
echo "package: $tgz"

timeout 900 podman run --rm --label kya-e2e=appinspect \
  -v "$out:/work:Z" -e DEBIAN_FRONTEND=noninteractive -e PIP_DISABLE_PIP_VERSION_CHECK=1 -e "APPINSPECT_VERSION=$APPINSPECT_VERSION" -e "PKG=/work/$name" \
  "$PYTHON_IMAGE" bash -euc '
    apt-get update -qq >/dev/null && apt-get install -y -qq libmagic1 >/dev/null
    python -m venv /tmp/ai && /tmp/ai/bin/pip install -q "splunk-appinspect==$APPINSPECT_VERSION"
    cd /tmp
    /tmp/ai/bin/splunk-appinspect inspect "$PKG" --output-file /work/appinspect.json --data-format json >/work/appinspect.txt 2>&1 || true
    /tmp/ai/bin/splunk-appinspect inspect "$PKG" --included-tags cloud --output-file /work/appinspect-cloud.json --data-format json >/work/appinspect-cloud.txt 2>&1 || true
  '

# Summary with the host python, isolated mode (-I), reading only the JSON reports.
python3 -I - "$out/appinspect.json" "$out/appinspect-cloud.json" <<'PY'
import json, sys
bad = 0
for path in sys.argv[1:]:
    with open(path) as f:
        report = json.load(f)
    summary = report["summary"]
    print(f"{path}: {json.dumps(summary, sort_keys=True)}")
    for r in report["reports"]:
        for g in r["groups"]:
            for c in g["checks"]:
                if c["result"] in ("failure", "error", "warning", "manual_check", "skipped", "future_failure"):
                    msgs = "; ".join(m["message"].splitlines()[0][:160] for m in c.get("messages", [])[:2])
                    print(f"  {c['result']}: {c['name']}: {msgs}")
    bad += summary.get("failure", 0) + summary.get("error", 0)
sys.exit(1 if bad else 0)
PY
