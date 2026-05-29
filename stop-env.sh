#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Logging ──────────────────────────────────────────────────────────────────
log() {
  echo -e "\033[0;32m[$(date '+%H:%M:%S')] $1\033[0m"
}

# ── Load environment ─────────────────────────────────────────────────────────
source "$SCRIPT_DIR/lib/env.sh"
load_env "$SCRIPT_DIR"

# ── Resolve nigiri binary ────────────────────────────────────────────────────
if [[ -n "${NIGIRI_BRANCH:-}" ]]; then
  NIGIRI="$SCRIPT_DIR/_build/nigiri/build/nigiri"
elif command -v nigiri &>/dev/null; then
  NIGIRI="nigiri"
else
  NIGIRI="$SCRIPT_DIR/_build/nigiri/build/nigiri"
fi

# ── Export vars for docker-compose interpolation ─────────────────────────────
export ARKD_IMAGE ARKD_WALLET_IMAGE ARK_CONTAINER
export BOLTZ_LND_IMAGE FULMINE_IMAGE BOLTZ_IMAGE NGINX_IMAGE
export BOLTZ_LND_P2P_PORT BOLTZ_LND_RPC_PORT FULMINE_GRPC_PORT FULMINE_API_PORT FULMINE_HTTP_PORT
export BOLTZ_GRPC_PORT BOLTZ_API_PORT BOLTZ_WS_PORT NGINX_PORT
export LNURL_IMAGE WALLET_IMAGE LNURL_PORT WALLET_PORT
export DELEGATOR_GRPC_PORT DELEGATOR_API_PORT DELEGATOR_HTTP_PORT
export EMULATOR_IMAGE EMULATOR_PORT EMULATOR_SECRET_KEY EMULATOR_ARKD_URL EMULATOR_LOG_LEVEL

# ── Stop emulator overlay if it was started ──────────────────────────────────
if docker ps --format '{{.Names}}' | grep -q '^emulator$'; then
  log "Stopping emulator overlay..."
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.emulator.yml" stop 2>/dev/null || true
fi

# ── Stop arkd override if custom image was used ──────────────────────────────
if docker ps --format '{{.Names}}' | grep -qE "^(ark|arkd|${ARK_CONTAINER})$" && \
   [ -n "$(docker inspect "${ARK_CONTAINER}" --format '{{.Config.Image}}' 2>/dev/null | grep -v 'nigiri')" ]; then
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" stop 2>/dev/null || true
fi

# ── Stop ark overlay stack ───────────────────────────────────────────────────
log "Stopping ark overlay stack..."
docker compose -f "$SCRIPT_DIR/docker/docker-compose.ark.yml" stop || true

# ── Stop nigiri ──────────────────────────────────────────────────────────────
log "Stopping nigiri..."
$NIGIRI stop || true

log "Environment stopped."
