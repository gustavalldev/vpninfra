#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_DIR="$ROOT_DIR/deploy/foreign-vless-node"

usage() {
  cat <<'USAGE'
Prepare runtime files for a foreign VLESS node.

Required env:
  SERVER_NAME          stable node id, e.g. foreign-vless-ru-03
  SERVER_HOST          public hostname used by clients and TLS SNI
  SERVER_IP            public server IP
  COUNTRY_CODE         ISO country code
  PROVISIONER_TOKEN    shared token used by vpnbot VPN_BACKEND_TOKEN

Optional env:
  SERVER_DISPLAY_NAME  human readable node name, default SERVER_NAME
  XRAY_PORT            public VLESS port, default 443
  PROVISIONER_PORT     provisioner HTTP port, default 3021
  XRAY_TRANSPORT       default tcp
  XRAY_SECURITY        default tls
  CERT_SOURCE_DIR      directory containing fullchain.pem and privkey.pem

Example:
  SERVER_NAME=foreign-vless-ru-03 \
  SERVER_HOST=vpn.example.com \
  SERVER_IP=203.0.113.10 \
  COUNTRY_CODE=RU \
  PROVISIONER_TOKEN=shared-secret \
  CERT_SOURCE_DIR=/etc/letsencrypt/live/vpn.example.com \
  ./scripts/prepare-vless-node-runtime.sh
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: $name" >&2
    usage >&2
    exit 1
  fi
}

require_env SERVER_NAME
require_env SERVER_HOST
require_env SERVER_IP
require_env COUNTRY_CODE
require_env PROVISIONER_TOKEN

SERVER_DISPLAY_NAME="${SERVER_DISPLAY_NAME:-$SERVER_NAME}"
XRAY_PORT="${XRAY_PORT:-443}"
XRAY_TRANSPORT="${XRAY_TRANSPORT:-tcp}"
XRAY_SECURITY="${XRAY_SECURITY:-tls}"
PROVISIONER_PORT="${PROVISIONER_PORT:-3021}"
XRAY_CONTAINER_NAME="${XRAY_CONTAINER_NAME:-foreign-vless-xray}"
PROVISIONER_CONTAINER_NAME="${PROVISIONER_CONTAINER_NAME:-foreign-vless-provisioner}"

mkdir -p "$NODE_DIR/config" "$NODE_DIR/certs"

cat > "$NODE_DIR/.env" <<ENV
SERVER_ROLE=vpn-node
SERVER_NAME=$SERVER_NAME
SERVER_HOST=$SERVER_HOST
SERVER_IP=$SERVER_IP
COUNTRY_CODE=$COUNTRY_CODE
VPN_PROTOCOL=VLESS
XRAY_PORT=$XRAY_PORT
XRAY_TRANSPORT=$XRAY_TRANSPORT
XRAY_SECURITY=$XRAY_SECURITY
XRAY_SNI=$SERVER_HOST
XRAY_CONTAINER_NAME=$XRAY_CONTAINER_NAME
PROVISIONER_CONTAINER_NAME=$PROVISIONER_CONTAINER_NAME
PROVISIONER_PORT=$PROVISIONER_PORT
PROVISIONER_TOKEN=$PROVISIONER_TOKEN
XRAY_CONFIG_FILE=./config/config.json
XRAY_CERTS_DIR=./certs
VPN_BACKEND_PROTOCOL=VLESS
VPN_BACKEND_PROFILE_FORMAT=uri
VPN_BACKEND_NODES_JSON=[{"id":"$SERVER_NAME","name":"$SERVER_DISPLAY_NAME","host":"$SERVER_HOST","ip":"$SERVER_IP","port":$XRAY_PORT,"country_code":"$COUNTRY_CODE","transport":"$XRAY_TRANSPORT","security":"$XRAY_SECURITY","sni":"$SERVER_HOST","enabled":true,"is_default":false}]
ENV

cat > "$NODE_DIR/config/config.json" <<JSON
{
  "log": {
    "loglevel": "warning"
  },
  "inbounds": [
    {
      "tag": "vless-tls",
      "listen": "0.0.0.0",
      "port": $XRAY_PORT,
      "protocol": "vless",
      "settings": {
        "clients": [],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "$XRAY_TRANSPORT",
        "security": "$XRAY_SECURITY",
        "tlsSettings": {
          "certificates": [
            {
              "certificateFile": "/etc/xray/certs/fullchain.pem",
              "keyFile": "/etc/xray/certs/privkey.pem"
            }
          ]
        }
      }
    }
  ],
  "outbounds": [
    {
      "tag": "direct",
      "protocol": "freedom"
    },
    {
      "tag": "blocked",
      "protocol": "blackhole"
    }
  ]
}
JSON

copy_cert_file() {
  local src="$1"
  local dest="$2"

  if [[ -r "$src" ]]; then
    cp "$src" "$dest"
    return
  fi

  if command -v sudo >/dev/null 2>&1 && sudo -n test -r "$src" 2>/dev/null; then
    sudo cp "$src" "$dest"
    sudo chown "$(id -u):$(id -g)" "$dest"
    return
  fi

  echo "Cannot read certificate file: $src" >&2
  exit 1
}

if [[ -n "${CERT_SOURCE_DIR:-}" ]]; then
  copy_cert_file "$CERT_SOURCE_DIR/fullchain.pem" "$NODE_DIR/certs/fullchain.pem"
  copy_cert_file "$CERT_SOURCE_DIR/privkey.pem" "$NODE_DIR/certs/privkey.pem"
  chmod 600 "$NODE_DIR/certs/privkey.pem"
fi

echo "Prepared $NODE_DIR/.env"
echo "Prepared $NODE_DIR/config/config.json"
if [[ ! -s "$NODE_DIR/certs/fullchain.pem" || ! -s "$NODE_DIR/certs/privkey.pem" ]]; then
  echo "TLS certs are still required in $NODE_DIR/certs/fullchain.pem and privkey.pem" >&2
fi
