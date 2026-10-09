#!/usr/bin/env bash
set -euo pipefail

KYA_VERSION="${KYA_VERSION:-latest}"
KYA_COMMAND="${KYA_COMMAND:-kya certify --window 30 --fail-on gap --json}"
KYA_ARTIFACTS="${KYA_ARTIFACTS:-.kya/certify}"

# Bitbucket Pipelines mounts the repository at BITBUCKET_CLONE_DIR.
# Fall back to the current directory for local testing.
cd "${BITBUCKET_CLONE_DIR:-.}"

echo "KYA pipe: installing @shield-agent/kya@${KYA_VERSION}"
npm i -g "@shield-agent/kya@${KYA_VERSION}"

echo "KYA pipe: running ${KYA_COMMAND}"
eval "${KYA_COMMAND}"

if [ -d "${KYA_ARTIFACTS}" ]; then
  echo "KYA pipe: artifacts available at ${KYA_ARTIFACTS}"
fi
