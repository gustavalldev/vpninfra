#!/usr/bin/env bash

set -euo pipefail

VERSION="${1:-v2.27.0}"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64)
    BIN_ARCH="x86_64"
    ;;
  aarch64|arm64)
    BIN_ARCH="aarch64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

INSTALL_DIR="${HOME}/.docker/cli-plugins"
BIN_PATH="${INSTALL_DIR}/docker-compose"
DOWNLOAD_URL="https://github.com/docker/compose/releases/download/${VERSION}/docker-compose-linux-${BIN_ARCH}"

mkdir -p "$INSTALL_DIR"
curl -fsSL "$DOWNLOAD_URL" -o "$BIN_PATH"
chmod +x "$BIN_PATH"

docker compose version
