# syntax=docker/dockerfile:1

# KYA CLI + local MCP gateway container
# Builds for linux/amd64 and linux/arm64.
# The gateway binary is pre-installed so the container works offline.

FROM node:24-slim

ARG KYA_VERSION=0.19.0
ARG GATE_VERSION=1.5.0
ARG RELEASE_REPO=The-Pixel-Boys/shield-kya

# KYA_HOME is the parent of the global .kya directory; the CLI appends .kya itself.
ENV KYA_HOME=/root
ENV PATH="/root/.kya/bin:${PATH}"

# Install tools needed to fetch and verify the gateway binary.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl tar && \
    rm -rf /var/lib/apt/lists/*

# Install the KYA CLI globally from npm.
RUN npm install -g "@shield-agent/kya@${KYA_VERSION}"

# Pre-download and verify the gateway binary for the image architecture.
ARG TARGETARCH
RUN set -eux; \
    ARCH="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$ARCH" in \
      amd64) GATE_ARCH=amd64 ;; \
      arm64) GATE_ARCH=arm64 ;; \
      *) echo "Unsupported architecture: $ARCH"; exit 1 ;; \
    esac; \
    mkdir -p /root/.kya/bin; \
    NAME="kya-gate-${GATE_VERSION}-linux-${GATE_ARCH}"; \
    BASE="https://github.com/${RELEASE_REPO}/releases/download/gate-v${GATE_VERSION}/${NAME}"; \
    curl -fsSL "${BASE}.tar.gz" -o "/tmp/${NAME}.tar.gz"; \
    curl -fsSL "${BASE}.tar.gz.sha256" -o "/tmp/${NAME}.tar.gz.sha256"; \
    EXPECTED=$(awk '{print $1}' "/tmp/${NAME}.tar.gz.sha256"); \
    ACTUAL=$(sha256sum "/tmp/${NAME}.tar.gz" | awk '{print $1}'); \
    if [ "$EXPECTED" != "$ACTUAL" ]; then \
      echo "Gateway binary checksum mismatch"; exit 1; \
    fi; \
    tar -xzf "/tmp/${NAME}.tar.gz" -C /root/.kya/bin; \
    chmod +x /root/.kya/bin/kya-gate; \
    rm -f "/tmp/${NAME}.tar.gz" "/tmp/${NAME}.tar.gz.sha256"; \
    kya-gate --version

# Mark the image as offline-ready: the gate does not need to download anything at runtime.
ENV KYA_OFFLINE=1

WORKDIR /workspace

ENTRYPOINT ["kya"]
CMD ["--help"]
