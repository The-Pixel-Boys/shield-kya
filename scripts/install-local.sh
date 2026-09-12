#!/usr/bin/env bash
# Install this checkout of @shield-agent/kya onto PATH as `kya`.
# Use after pulling feat/oss-observe-receipt-dashboard (or main once merged).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if command -v pnpm >/dev/null 2>&1; then
  pnpm run build
else
  npm run build
fi
npm install -g .
echo "installed: $(command -v kya)"
kya --help | head -5
echo "tip: prefer \`kya\` over \`npx @shield-agent/kya\` until the PR is published to npm"
echo "     rebuild+reinstall: $ROOT/scripts/install-local.sh"
