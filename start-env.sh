#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Verify script is not running from an empty submodule ─────────────────────
if [ ! -f "$SCRIPT_DIR/.env.defaults" ]; then
  echo "ERROR: $SCRIPT_DIR/.env.defaults not found."
  echo "If this is a git submodule, run: git submodule update --init"
  exit 1
fi

# ── Logging ──────────────────────────────────────────────────────────────────
log() {
  echo -e "\033[0;32m[$(date '+%H:%M:%S')] $1\033[0m"
}

# ── Parse arguments ──────────────────────────────────────────────────────────
CLEAN=false
USER_ENV=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)
      CLEAN=true
      shift
      ;;
    --env)
      USER_ENV="$2"
      shift 2
      ;;
    *)
      log "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── Load environment ────────────────────────────────────────────────────────
source "$SCRIPT_DIR/lib/env.sh"
load_env "$SCRIPT_DIR"

# ── Export vars for docker-compose interpolation ─────────────────────────────
export BOLTZ_LND_IMAGE FULMINE_IMAGE BOLTZ_IMAGE NGINX_IMAGE LNURL_IMAGE WALLET_IMAGE
export ARKD_IMAGE ARKD_WALLET_IMAGE
export BOLTZ_LND_P2P_PORT BOLTZ_LND_RPC_PORT FULMINE_GRPC_PORT FULMINE_API_PORT FULMINE_HTTP_PORT
export DELEGATOR_GRPC_PORT DELEGATOR_API_PORT DELEGATOR_HTTP_PORT
export BOLTZ_GRPC_PORT BOLTZ_API_PORT BOLTZ_WS_PORT NGINX_PORT LNURL_PORT WALLET_PORT
export ARKD_WALLET_SIGNER_KEY ARKD_PUBLIC_UNILATERAL_EXIT_DELAY ARKD_CHECKPOINT_EXIT_DELAY
export ARKD_VTXO_TREE_EXPIRY
export ARKD_UNILATERAL_EXIT_DELAY ARKD_BOARDING_EXIT_DELAY ARKD_LIVE_STORE_TYPE
export ARKD_LOG_LEVEL ARKD_SESSION_DURATION
export ARK_OFFCHAIN_OUTPUT_FEE ARK_ONCHAIN_OUTPUT_FEE ARK_OFFCHAIN_INPUT_FEE ARK_ONCHAIN_INPUT_FEE
export ARKD_UTXO_MAX_AMOUNT ARKD_VTXO_MAX_AMOUNT ARKD_UTXO_MIN_AMOUNT ARKD_VTXO_MIN_AMOUNT
export EMULATOR_IMAGE EMULATOR_PORT EMULATOR_SECRET_KEY EMULATOR_ARKD_URL EMULATOR_LOG_LEVEL
export ARK_CONTAINER

# ── Nigiri resolution ───────────────────────────────────────────────────────
build_nigiri_from_source() {
  local branch="$1"
  local repo_dir="$SCRIPT_DIR/_build/nigiri"
  local os=$(uname -s | tr '[:upper:]' '[:lower:]')
  local arch=$(uname -m)
  case "$arch" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
  esac
  local bin_name="nigiri-${os}-${arch}"
  NIGIRI="${repo_dir}/build/${bin_name}"

  if [ ! -f "$NIGIRI" ] || [ "$CLEAN" = true ]; then
    log "Building nigiri from source (branch: $branch)..."
    if [ ! -d "$repo_dir" ]; then
      git clone -b "$branch" "$NIGIRI_REPO_URL" "$repo_dir"
    else
      cd "$repo_dir"
      git stash 2>/dev/null || true
      git fetch origin
      git checkout "$branch"
      git pull origin "$branch"
      cd "$SCRIPT_DIR"
    fi
    cd "$repo_dir" && make install && make build && cd "$SCRIPT_DIR"
    if [ ! -f "$NIGIRI" ]; then
      log "ERROR: Failed to build nigiri binary"
      exit 1
    fi
    log "Nigiri built successfully"
  else
    log "Nigiri found: $($NIGIRI --version)"
  fi

  # Symlink so nigiri can find itself
  local build_dir="${repo_dir}/build"
  if [ -f "$NIGIRI" ] && [ ! -f "${build_dir}/nigiri" ]; then
    ln -sf "$bin_name" "${build_dir}/nigiri"
  fi
  export PATH="${build_dir}:${PATH}"
}

resolve_nigiri() {
  if [ -n "${NIGIRI_BRANCH:-}" ]; then
    # Build from source using the specified branch
    build_nigiri_from_source "$NIGIRI_BRANCH"
  elif command -v nigiri &>/dev/null; then
    # NIGIRI_BRANCH was explicitly cleared — use system binary
    NIGIRI="nigiri"
    log "Using system nigiri: $(nigiri --version)"
  else
    log "ERROR: NIGIRI_BRANCH is empty and no system nigiri found on PATH"
    exit 1
  fi
}

# ── Helper: setup_lnd_wallet ─────────────────────────────────────────────────
setup_lnd_wallet() {
  log "Setting up LND for Lightning swaps..."
  sleep 10

  log "Getting LND address..."
  ln_address=$(docker exec boltz-lnd lncli --network=regtest newaddress p2wkh | jq -r '.address')
  log "LND address: $ln_address"

  log "Funding LND wallet..."
  $NIGIRI faucet "$ln_address" "$LND_FAUCET_AMOUNT"

  log "Waiting for LND funding confirmation..."
  sleep 10

  lnd_balance=$(docker exec boltz-lnd lncli --network=regtest walletbalance | jq -r '.account_balance.default.confirmed_balance')
  if [ "$lnd_balance" -lt 1000000 ]; then
    log "ERROR: LND wallet balance ($lnd_balance) is less than 1,000,000 sats. Funding failed."
    exit 1
  fi
  log "LND balance: $lnd_balance"

  counterparty_node_pubkey=$(docker exec lnd lncli --network=regtest getinfo | jq -r '.identity_pubkey')
  log "Opening channel to counterparty node ($counterparty_node_pubkey)..."
  docker exec boltz-lnd lncli --network=regtest openchannel --node_key "$counterparty_node_pubkey" --connect "lnd:9735" --local_amt "$LND_CHANNEL_SIZE" --sat_per_vbyte 1 --min_confs 0

  log "Mining ten blocks to confirm channel..."
  $NIGIRI rpc --generate 10

  log "Waiting for channel to become active..."
  sleep 10

  log "Creating and paying test invoice..."
  invoice=$(docker exec lnd lncli --network=regtest addinvoice --amt 500000 | jq -r '.payment_request')
  docker exec boltz-lnd lncli --network=regtest payinvoice --force $invoice

  log "LND wallet setup completed successfully!"
}

# ── Helper: setup_arkd_fees ──────────────────────────────────────────────────
setup_arkd_fees() {
  log "Configuring arkd intent fees..."
  local fee_response
  fee_response=$(docker exec "$ARK_CONTAINER" wget -qO- \
    --post-data="{\"fees\":{\"offchainInputFee\":\"${ARK_OFFCHAIN_INPUT_FEE}\",\"onchainInputFee\":\"${ARK_ONCHAIN_INPUT_FEE}\",\"offchainOutputFee\":\"${ARK_OFFCHAIN_OUTPUT_FEE}\",\"onchainOutputFee\":\"${ARK_ONCHAIN_OUTPUT_FEE}\"}}" \
    --header="Content-Type: application/json" \
    http://localhost:7071/v1/admin/intentFees 2>&1) || {
    log "WARNING: Failed to set arkd fees (admin port may not be available)"
    return 0
  }
  local verify
  verify=$(docker exec "$ARK_CONTAINER" wget -qO- http://localhost:7071/v1/admin/intentFees 2>&1)
  log "arkd fees configured: $verify"
}

# ── Helper: setup_fulmine_wallet ─────────────────────────────────────────────
setup_fulmine_wallet() {
  log "Setting up Fulmine wallet..."

  log "Waiting for Fulmine service to be ready..."
  max_attempts=15
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    if curl -s --connect-timeout 5 --max-time 10 http://localhost:${FULMINE_API_PORT}/api/v1/wallet/status >/dev/null 2>&1; then
      log "Fulmine service is ready!"
      break
    fi
    log "Waiting for Fulmine service... (attempt $attempt/$max_attempts)"
    sleep 2
    ((attempt++))
  done
  if [ $attempt -gt $max_attempts ]; then
    log "ERROR: Fulmine service failed to start within expected time"
    exit 1
  fi

  log "Generating seed..."
  seed_response=$(curl -s -X GET http://localhost:${FULMINE_API_PORT}/api/v1/wallet/genseed)
  private_key=$(echo "$seed_response" | jq -r '.nsec')
  log "Generated private key: $private_key"

  log "Creating Fulmine wallet..."
  curl -X POST http://localhost:${FULMINE_API_PORT}/api/v1/wallet/create \
       -H "Content-Type: application/json" \
       -d "{\"private_key\": \"$private_key\", \"password\": \"password\", \"server_url\": \"http://ark:7070\"}"

  log "Unlocking Fulmine wallet..."
  curl -X POST http://localhost:${FULMINE_API_PORT}/api/v1/wallet/unlock \
       -H "Content-Type: application/json" \
       -d '{"password": "password"}'

  
  log "Waiting for Fulmine status to be ready..."
  max_attempts=15
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    local status_response=$(curl -s -X GET http://localhost:${FULMINE_API_PORT}/api/v1/wallet/status)
    local synced=$(echo "$status_response" | jq -r '.synced // false')
    local unlocked=$(echo "$status_response" | jq -r '.unlocked // false')
    local initialized=$(echo "$status_response" | jq -r '.initialized // false')
    if [ "$initialized" = "true" ] && [ "$synced" = "true" ] && [ "$unlocked" = "true" ]; then
      log "Fulmine wallet is ready! $status_response"
      break
    fi
    log "Waiting for Fulmine status to be ready... (attempt $attempt/$max_attempts)"
    sleep 2
    ((attempt++))
  done
  if [ $attempt -gt $max_attempts ]; then
    log "ERROR: Fulmine wallet failed to become ready within expected time"
    exit 1
  fi

  log "Getting Fulmine wallet address..."
  max_attempts=5
  attempt=1
  local fulmine_address=""
  while [ $attempt -le $max_attempts ]; do
    local address_response=$(curl -s -X GET http://localhost:${FULMINE_API_PORT}/api/v1/address)
    fulmine_address=$(echo "$address_response" | jq -r '.address' | sed 's/bitcoin://' | sed 's/?ark=.*//')
    if [[ "$fulmine_address" != "null" && -n "$fulmine_address" ]]; then
      log "Fulmine address: $fulmine_address"
      break
    fi
    log "Address not ready yet (attempt $attempt/$max_attempts), waiting..."
    sleep 2
    ((attempt++))
  done
  if [[ "$fulmine_address" == "null" || -z "$fulmine_address" ]]; then
    log "ERROR: Failed to get valid Fulmine wallet address"
    exit 1
  fi

  log "Funding Fulmine wallet..."
  $NIGIRI faucet "$fulmine_address" "$FULMINE_FAUCET_AMOUNT"

  # Mine blocks to confirm boarding UTXO before settling
  log "Mining blocks for Fulmine boarding confirmation..."
  $NIGIRI rpc --generate 3
  sleep 10

  log "Settling Fulmine wallet..."
  if ! timeout 120 curl -s --max-time 110 -X GET http://localhost:${FULMINE_API_PORT}/api/v1/settle; then
    log "WARNING: Fulmine settle timed out or failed, continuing..."
  fi

  # Wait for batch round and mine commitment tx
  sleep 15
  $NIGIRI rpc --generate 3
  sleep 3

  log "Getting transaction history..."
  curl -s --max-time 30 -X GET http://localhost:${FULMINE_API_PORT}/api/v1/transactions || true
  echo ""

  log "Fulmine wallet setup completed successfully!"
}

# ── Helper: setup_delegator_wallet ───────────────────────────────────────────
setup_delegator_wallet() {
  log "Setting up Fulmine delegator wallet..."

  # Wait for delegator service to be ready (fulmine needs arkd to be fully serving)
  max_attempts=30
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    if curl -s --connect-timeout 5 --max-time 10 http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/status >/dev/null 2>&1; then
      log "Delegator service is ready!"
      break
    fi
    log "Waiting for delegator service... (attempt $attempt/$max_attempts)"
    sleep 2
    ((attempt++))
  done

  if [ $attempt -gt $max_attempts ]; then
    log "ERROR: Delegator service failed to start within expected time"
    exit 1
  fi

  # Generate seed and create wallet
  log "Generating delegator seed..."
  seed_response=$(curl -s -X GET http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/genseed)
  private_key=$(echo "$seed_response" | jq -r '.nsec')

  log "Creating delegator wallet..."
  curl -s -X POST http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/create \
       -H "Content-Type: application/json" \
       -d "{\"private_key\": \"$private_key\", \"password\": \"password\", \"server_url\": \"http://ark:7070\"}"

  log "Unlocking delegator wallet..."
  curl -s -X POST http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/unlock \
       -H "Content-Type: application/json" \
       -d '{"password": "password"}'

  log "Waiting for delegator status to be ready..."
  max_attempts=15
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    local status_response=$(curl -s -X GET http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/status)
    local synced=$(echo "$status_response" | jq -r '.synced // false')
    local unlocked=$(echo "$status_response" | jq -r '.unlocked // false')
    local initialized=$(echo "$status_response" | jq -r '.initialized // false')
    if [ "$initialized" = "true" ] && [ "$synced" = "true" ] && [ "$unlocked" = "true" ]; then
      log "Delegator wallet is ready! $status_response"
      break
    fi
    log "Waiting for delegator status to be ready... (attempt $attempt/$max_attempts)"
    sleep 2
    ((attempt++))
  done
  if [ $attempt -gt $max_attempts ]; then
    log "ERROR: Delegator wallet failed to become ready within expected time"
    exit 1
  fi
  
  # Fund delegator wallet
  log "Getting delegator address..."
  max_attempts=5
  attempt=1
  local delegator_address=""
  while [ $attempt -le $max_attempts ]; do
    local address_response=$(curl -s -X GET http://localhost:${DELEGATOR_API_PORT}/api/v1/address)
    delegator_address=$(echo "$address_response" | jq -r '.address' | sed 's/bitcoin://' | sed 's/?ark=.*//')
    if [[ "$delegator_address" != "null" && -n "$delegator_address" ]]; then
      break
    fi
    log "Address not ready yet (attempt $attempt/$max_attempts), waiting..."
    sleep 2
    ((attempt++))
  done

  if [[ "$delegator_address" == "null" || -z "$delegator_address" ]]; then
    log "ERROR: Failed to get delegator address"
    exit 1
  fi

  log "Delegator address: $delegator_address"
  $NIGIRI faucet "$delegator_address" 0.01

  # Mine blocks to confirm boarding UTXO before settling
  log "Mining blocks for delegator boarding confirmation..."
  $NIGIRI rpc --generate 3
  sleep 10

  log "Settling delegator wallet..."
  if ! timeout 120 curl -s --max-time 110 -X GET http://localhost:${DELEGATOR_API_PORT}/api/v1/settle; then
    log "WARNING: Delegator settle timed out or failed, continuing..."
  fi

  # Wait for batch round and mine commitment tx
  sleep 15
  $NIGIRI rpc --generate 3
  sleep 3

  log "Getting transaction history..."
  curl -s --max-time 30 -X GET http://localhost:${DELEGATOR_API_PORT}/api/v1/transactions || true
  echo ""

  log "Delegator wallet setup completed!"
}

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

resolve_nigiri

# ── Ensure GID is exported for docker-compose user mapping ─────────────────
# Bash sets UID automatically; GID is not set, so docker-compose falls back to
# 1000 which may not match the host user's group, causing permission errors.
export GID=$(id -g)

# ── Clean if requested ───────────────────────────────────────────────────────
if [ "$CLEAN" = true ]; then
  export USER_ENV
  source "$SCRIPT_DIR/clean-env.sh"
fi

# ── Pull and start Nigiri ────────────────────────────────────────────────────
NIGIRI_FRESH=false
if docker ps --format '{{.Names}}' | grep -q '^bitcoin$'; then
  log "Nigiri already running, skipping start..."
else
  NIGIRI_FRESH=true
  log "Pulling latest Nigiri images..."
  $NIGIRI update || log "Nigiri update failed, continuing with existing images..."

  log "Starting Nigiri with Ark and LN support..."
  if ! $NIGIRI start --ark --ln; then
    # Only tolerate the error if nigiri actually started (bitcoin is running)
    if ! docker ps --format '{{.Names}}' | grep -q '^bitcoin$'; then
      log "ERROR: nigiri start failed and bitcoin is not running."
      log "Try: ./clean-env.sh and then restart."
      exit 1
    fi
    log "Nigiri may already be running, continuing..."
  fi

  # If bitcoin is crash-looping (e.g. can't write settings.json due to root-owned
  # volume dirs), fix ownership of just the bitcoin data dir and restart it.
  sleep 5
  if ! docker exec bitcoin bitcoin-cli -regtest getblockchaininfo >/dev/null 2>&1; then
    BITCOIN_VOL="${HOME}/.nigiri/volumes/bitcoin"
    if [ -d "$BITCOIN_VOL" ] && [ "$(stat -c '%u' "$BITCOIN_VOL" 2>/dev/null || stat -f '%u' "$BITCOIN_VOL" 2>/dev/null)" != "$(id -u)" ]; then
      log "Fixing bitcoin volume permissions..."
      docker run --rm -v "$BITCOIN_VOL:/vol" alpine chown -R "$(id -u):$(id -g)" /vol
      docker restart bitcoin
      sleep 5
    fi
  fi
fi

# ── Bitcoin Core low-fee config (optional — restarts bitcoin, chopsticks, nbxplorer) ──
if [ "$NIGIRI_FRESH" = true ] && [ "${BITCOIN_LOW_FEE:-true}" = true ]; then
  # Sanity check: bitcoin.conf must contain the regtest config written by nigiri.
  # If it's missing, nigiri didn't initialize properly (stale volumes, failed cleanup).
  if ! docker exec bitcoin grep -q 'regtest=1' /data/.bitcoin/bitcoin.conf 2>/dev/null; then
    log "ERROR: bitcoin.conf is missing regtest=1 — volumes may be stale."
    log "Run: ./clean-env.sh and then restart."
    exit 1
  fi
  log "Configuring Bitcoin Core to accept low-fee transactions..."
  docker exec bitcoin sh -c 'printf "\nminrelaytxfee=0.0\nmintxfee=0.0\n" >> /data/.bitcoin/bitcoin.conf'
  docker restart bitcoin
  sleep 5
  log "Bitcoin Core restarted with minrelaytxfee=0 and mintxfee=0"
  log "Waiting for Bitcoin Core to be ready after restart..."
  max_attempts=30
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    if docker exec bitcoin bitcoin-cli -regtest getblockchaininfo >/dev/null 2>&1; then
      log "Bitcoin Core is ready"
      break
    fi
    sleep 3
    ((attempt++))
  done
  if [ $attempt -gt $max_attempts ]; then
    log "WARNING: Bitcoin Core not responding after restart, continuing..."
  fi

  # Restart chopsticks to reconnect after Bitcoin Core restart
  log "Restarting chopsticks block miner..."
  docker restart chopsticks

  # Restart nbxplorer only if it exists (not all stacks include it)
  # The container may be named "nbxplorer" or auto-named "nigiri-nbxplorer-1"
  NBXPLORER_CONTAINER=$(docker ps -a --format '{{.Names}}' | grep -E '^(nbxplorer|nigiri-nbxplorer)' | head -1)
  if [ -n "$NBXPLORER_CONTAINER" ]; then
    log "Restarting nbxplorer ($NBXPLORER_CONTAINER)..."
    docker restart "$NBXPLORER_CONTAINER"
    sleep 5
    log "Waiting for nbxplorer to sync after restart..."
    max_attempts=10
    attempt=1
    while [ $attempt -le $max_attempts ]; do
      if curl -s http://localhost:32838/v1/cryptos/btc/status 2>/dev/null | grep -q '"isFullySynched":true'; then
        log "nbxplorer is fully synced"
        break
      fi
      sleep 3
      ((attempt++))
    done
    if [ $attempt -gt $max_attempts ]; then
      log "WARNING: nbxplorer not synced after restart, continuing..."
    fi
  fi
elif [ "$NIGIRI_FRESH" = true ]; then
  log "Skipping Bitcoin Core low-fee config (BITCOIN_LOW_FEE=false)"
fi

# ── Override arkd if custom image specified ──────────────────────────────────
if [ -n "${ARKD_IMAGE:-}" ]; then
  log "Custom ARKD_IMAGE set: $ARKD_IMAGE"

  # Stop and remove old ark containers AND volumes to prevent stale state.
  # Stop both names: nigiri's built-in "ark" and any prior custom "$ARK_CONTAINER".
  docker stop ark "$ARK_CONTAINER" ark-wallet 2>/dev/null || true
  docker rm ark "$ARK_CONTAINER" ark-wallet 2>/dev/null || true
  docker volume rm nigiri_ark_datadir nigiri_ark_wallet_datadir 2>/dev/null || true
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" pull
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.arkd-override.yml" up -d
  sleep 5
fi

# ── Docker compose overlay ──────────────────────────────────────────────────
if docker ps --format '{{.Names}}' | grep -q '^boltz$'; then
  log "Ark stack already running, skipping..."
else
  log "Pulling latest custom Ark stack images..."
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.ark.yml" pull
  log "Starting ark stack..."
  docker compose -f "$SCRIPT_DIR/docker/docker-compose.ark.yml" up -d
fi

# ── Wait for arkd and init wallet ────────────────────────────────────────────
arkd_ready=$(curl -s http://localhost:7070/v1/info 2>/dev/null | jq -r '.pubkey // empty' 2>/dev/null || echo "")
if [ -n "$arkd_ready" ]; then
  log "arkd wallet already initialized, skipping..."
else
  if [ -n "${ARKD_IMAGE:-}" ]; then
    # Custom arkd — create wallet via admin API, then init CLI
    # Step 1: wait for admin HTTP endpoint
    log "Waiting for custom arkd admin endpoint..."
    max_attempts=30
    attempt=1
    while [ $attempt -le $max_attempts ]; do
      if curl -sf http://localhost:7071/v1/admin/intentFees >/dev/null 2>&1; then
        log "arkd admin endpoint is up"
        break
      fi
      log "Waiting for arkd... (attempt $attempt/$max_attempts)"
      sleep 3
      ((attempt++))
    done
    if [ $attempt -gt $max_attempts ]; then
      log "ERROR: arkd admin endpoint failed to respond — dumping diagnostics"
      log "=== ark container status ==="
      docker ps -a --filter "name=$ARK_CONTAINER" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1
      log "=== ark-wallet logs (last 30 lines) ==="
      docker logs ark-wallet 2>&1 | tail -30
      log "=== $ARK_CONTAINER logs (last 30 lines) ==="
      docker logs "$ARK_CONTAINER" 2>&1 | tail -30
      exit 1
    fi

    # Step 2: create and unlock wallet via admin API
    wallet_status=$(curl -s http://localhost:7071/v1/admin/wallet/status 2>/dev/null || echo "{}")
    wallet_initialized=$(echo "$wallet_status" | jq -r '.initialized // false' 2>/dev/null || echo "false")

    if [ "$wallet_initialized" != "true" ]; then
      log "Creating arkd wallet via admin API..."
      seed_resp=$(curl -s http://localhost:7071/v1/admin/wallet/seed 2>/dev/null)
      seed=$(echo "$seed_resp" | jq -r '.seed // empty' 2>/dev/null || echo "")
      if [ -z "$seed" ]; then
        log "ERROR: Failed to generate wallet seed (response: $seed_resp)"
        docker logs "$ARK_CONTAINER" 2>&1 | tail -20
        exit 1
      fi
      create_resp=$(curl -s -X POST http://localhost:7071/v1/admin/wallet/create \
        -H "Content-Type: application/json" \
        -d "{\"seed\": \"$seed\", \"password\": \"$ARKD_PASSWORD\"}" 2>/dev/null)
      log "Wallet created: $create_resp"
    else
      log "Wallet already initialized"
    fi

    wallet_status=$(curl -s http://localhost:7071/v1/admin/wallet/status 2>/dev/null || echo "{}")
    wallet_unlocked=$(echo "$wallet_status" | jq -r '.unlocked // false' 2>/dev/null || echo "false")

    if [ "$wallet_unlocked" != "true" ]; then
      log "Unlocking arkd wallet..."
      curl -s -X POST http://localhost:7071/v1/admin/wallet/unlock \
        -H "Content-Type: application/json" \
        -d "{\"password\": \"$ARKD_PASSWORD\"}" >/dev/null 2>&1
    fi

    # Step 2b: wait for wallet to sync
    log "Waiting for wallet to sync..."
    max_attempts=60
    attempt=1
    while [ $attempt -le $max_attempts ]; do
      wallet_status=$(curl -s http://localhost:7071/v1/admin/wallet/status 2>/dev/null || echo "{}")
      wallet_synced=$(echo "$wallet_status" | jq -r '.synced // false' 2>/dev/null || echo "false")
      if [ "$wallet_synced" = "true" ]; then
        log "Wallet synced"
        break
      fi
      log "Wallet syncing... (attempt $attempt/$max_attempts)"
      sleep 3
      ((attempt++))
    done
    if [ $attempt -gt $max_attempts ]; then
      log "ERROR: Wallet failed to sync — dumping diagnostics"
      log "=== wallet status ==="
      curl -s http://localhost:7071/v1/admin/wallet/status 2>&1
      log "=== ark-wallet logs (last 30 lines) ==="
      docker logs ark-wallet 2>&1 | tail -30
      log "=== $ARK_CONTAINER logs (last 30 lines) ==="
      docker logs "$ARK_CONTAINER" 2>&1 | tail -30
      exit 1
    fi

    # Step 3: fund SERVER wallet and generate blocks for fee estimation
    server_addr=$(curl -s http://localhost:7071/v1/admin/wallet/address | jq -r '.address // empty' 2>/dev/null)
    if [ -n "$server_addr" ]; then
      log "Funding arkd server wallet at $server_addr (21 txs for fee estimation)..."
      for i in $(seq 1 21); do
        $NIGIRI faucet "$server_addr" 1 >/dev/null 2>&1
      done
      log "Server wallet funded with 21 BTC across 21 blocks"
      sleep 2
      balance=$(curl -s http://localhost:7071/v1/admin/wallet/balance 2>/dev/null || echo "{}")
      log "Server wallet balance: $balance"
    else
      log "WARNING: Could not get server wallet address, falling back to client funding"
      onchain_addr=$(docker exec "$ARK_CONTAINER" arkd receive 2>/dev/null | jq -r ".onchain_address")
      $NIGIRI faucet "$onchain_addr" "$ARKD_FAUCET_AMOUNT"
      # Convert onchain funds to offchain via redeem-notes
      note=$(docker exec "$ARK_CONTAINER" arkd note --amount 100000000 2>/dev/null)
      docker exec "$ARK_CONTAINER" arkd redeem-notes -n "$note" --password "$ARKD_PASSWORD" 2>/dev/null || log "WARNING: redeem-notes failed (older arkd version?)"
    fi
  else
    # Nigiri's built-in arkd — same admin API, container named "ark".
    log "Waiting for arkd admin endpoint..."
    max_attempts=30
    attempt=1
    while [ $attempt -le $max_attempts ]; do
      if docker exec "$ARK_CONTAINER" wget -qO- http://localhost:7071/v1/admin/wallet/status >/dev/null 2>&1; then
        log "arkd admin endpoint is up"
        break
      fi
      log "Waiting for arkd... (attempt $attempt/$max_attempts)"
      sleep 3
      ((attempt++))
    done
    if [ $attempt -gt $max_attempts ]; then
      log "ERROR: arkd failed to start within expected time"
      exit 1
    fi

    wallet_status=$(docker exec "$ARK_CONTAINER" wget -qO- http://localhost:7071/v1/admin/wallet/status 2>/dev/null || echo "{}")
    wallet_initialized=$(echo "$wallet_status" | jq -r '.initialized // false' 2>/dev/null || echo "false")

    if [ "$wallet_initialized" != "true" ]; then
      log "Creating server wallet..."
      seed_resp=$(docker exec "$ARK_CONTAINER" wget -qO- http://localhost:7071/v1/admin/wallet/seed 2>/dev/null)
      seed=$(echo "$seed_resp" | jq -r '.seed // empty' 2>/dev/null || echo "")
      if [ -z "$seed" ]; then
        log "ERROR: Failed to generate wallet seed (response: $seed_resp)"
        docker logs "$ARK_CONTAINER" 2>&1 | tail -20
        exit 1
      fi
      create_resp=$(docker exec "$ARK_CONTAINER" wget -qO- \
        --post-data="{\"seed\": \"$seed\", \"password\": \"$ARKD_PASSWORD\"}" \
        --header="Content-Type: application/json" \
        http://localhost:7071/v1/admin/wallet/create 2>/dev/null)
      log "Server wallet created: $create_resp"
    else
      log "Server wallet already initialized"
    fi

    wallet_status=$(docker exec "$ARK_CONTAINER" wget -qO- http://localhost:7071/v1/admin/wallet/status 2>/dev/null || echo "{}")
    wallet_unlocked=$(echo "$wallet_status" | jq -r '.unlocked // false' 2>/dev/null || echo "false")

    if [ "$wallet_unlocked" != "true" ]; then
      log "Unlocking server wallet..."
      docker exec "$ARK_CONTAINER" wget -qO- \
        --post-data="{\"password\": \"$ARKD_PASSWORD\"}" \
        --header="Content-Type: application/json" \
        http://localhost:7071/v1/admin/wallet/unlock >/dev/null 2>&1
    fi

    log "Waiting for wallet to sync..."
    max_attempts=60
    attempt=1
    while [ $attempt -le $max_attempts ]; do
      wallet_status=$(docker exec "$ARK_CONTAINER" wget -qO- http://localhost:7071/v1/admin/wallet/status 2>/dev/null || echo "{}")
      wallet_synced=$(echo "$wallet_status" | jq -r '.synced // false' 2>/dev/null || echo "false")
      if [ "$wallet_synced" = "true" ]; then
        log "Wallet synced"
        break
      fi
      log "Wallet syncing... (attempt $attempt/$max_attempts)"
      sleep 3
      ((attempt++))
    done
    if [ $attempt -gt $max_attempts ]; then
      log "ERROR: Wallet failed to sync — dumping diagnostics"
      log "=== wallet status ==="
      docker exec "$ARK_CONTAINER" wget -qO- http://localhost:7071/v1/admin/wallet/status 2>&1
      log "=== ark-wallet logs (last 30 lines) ==="
      docker logs ark-wallet 2>&1 | tail -30
      log "=== $ARK_CONTAINER logs (last 30 lines) ==="
      docker logs "$ARK_CONTAINER" 2>&1 | tail -30
      exit 1
    fi

    # Fund SERVER wallet and generate blocks for fee estimation
    server_addr=$(docker exec "$ARK_CONTAINER" wget -qO- http://localhost:7071/v1/admin/wallet/address 2>/dev/null | jq -r '.address // empty' 2>/dev/null)
    if [ -n "$server_addr" ]; then
      log "Funding arkd server wallet at $server_addr (21 txs for fee estimation)..."
      for i in $(seq 1 21); do
        $NIGIRI faucet "$server_addr" 1 >/dev/null 2>&1
      done
      log "Server wallet funded with 21 BTC across 21 blocks"
      sleep 2
      balance=$(docker exec "$ARK_CONTAINER" wget -qO- http://localhost:7071/v1/admin/wallet/balance 2>/dev/null || echo "{}")
      log "Server wallet balance: $balance"
    else
      log "WARNING: Could not get server wallet address, falling back to client funding"
      $NIGIRI faucet $($NIGIRI ark receive | jq -r ".onchain_address") "$ARKD_FAUCET_AMOUNT"
      $NIGIRI ark redeem-notes -n $($NIGIRI ark note --amount 100000000) --password "$ARKD_PASSWORD" 2>/dev/null || log "WARNING: redeem-notes failed (older arkd version?)"
    fi
  fi
fi


# ── Setup services (idempotent) ─────────────────────────────────────────────
# Fulmine: check if wallet already exists
fulmine_status=$(curl -s --connect-timeout 10 --max-time 15 http://localhost:${FULMINE_API_PORT}/api/v1/wallet/status 2>/dev/null || echo "")
if echo "$fulmine_status" | jq -e '.initialized' 2>/dev/null | grep -q 'true'; then
  log "Fulmine wallet already initialized, skipping..."
else
  setup_fulmine_wallet
fi

# Delegator: check if wallet already exists
delegator_status=$(curl -s --connect-timeout 10 --max-time 15 http://localhost:${DELEGATOR_API_PORT}/api/v1/wallet/status 2>/dev/null || echo "")
if echo "$delegator_status" | jq -e '.initialized' 2>/dev/null | grep -q 'true'; then
  log "Delegator wallet already initialized, skipping..."
else
  setup_delegator_wallet
fi

# LND: check if channel already exists
channel_count=$(docker exec boltz-lnd lncli --network=regtest listchannels 2>/dev/null | jq '.channels | length' 2>/dev/null || echo "0")
if [ "$channel_count" -gt 0 ]; then
  log "LND channel already open, skipping setup..."
else
  setup_lnd_wallet
fi

setup_arkd_fees

# ── Wait for boltz-lnd, restart boltz, verify pairs ─────────────────────────
log "Waiting for boltz-lnd wallet to be ready..."
max_attempts=30
attempt=1
while [ $attempt -le $max_attempts ]; do
  if docker exec boltz-lnd lncli --network=regtest getinfo >/dev/null 2>&1; then
    log "boltz-lnd wallet is ready"
    break
  fi
  log "boltz-lnd wallet not ready yet (attempt $attempt/$max_attempts)"
  sleep 2
  ((attempt++))
done
if [ $attempt -gt $max_attempts ]; then
  log "ERROR: boltz-lnd wallet failed to initialize"
  exit 1
fi

log "Restarting Boltz to reconnect to boltz-lnd..."
docker restart boltz
sleep 5

# Fund Boltz Bitcoin Core wallet for on-chain swaps (reverse swaps, chain swaps)
log "Funding Boltz Bitcoin Core wallet..."
# Boltz uses preferredWallet = "core" which maps to Bitcoin Core's default wallet.
# Try each wallet until we successfully fund one; fall back to the default ("") wallet.
boltz_funded=false
for boltz_wallet in $(docker exec bitcoin bitcoin-cli -regtest listwallets 2>/dev/null | jq -r '.[]' 2>/dev/null); do
  boltz_addr=$(docker exec bitcoin bitcoin-cli -regtest -rpcwallet="$boltz_wallet" getnewaddress 2>/dev/null)
  if [ -n "$boltz_addr" ]; then
    $NIGIRI faucet "$boltz_addr" 5
    log "Boltz wallet '$boltz_wallet' funded at $boltz_addr"
    boltz_funded=true
    break
  fi
done
if [ "$boltz_funded" = "false" ]; then
  # Try default wallet (empty name)
  boltz_addr=$(docker exec bitcoin bitcoin-cli -regtest getnewaddress 2>/dev/null)
  if [ -n "$boltz_addr" ]; then
    $NIGIRI faucet "$boltz_addr" 5
    log "Boltz default wallet funded at $boltz_addr"
  else
    log "WARNING: Could not fund any Boltz wallet in Bitcoin Core"
  fi
fi

log "Verifying Boltz ARK/BTC pairs..."
max_attempts=30
attempt=1
while [ $attempt -le $max_attempts ]; do
  pairs=$(curl -s --connect-timeout 5 --max-time 15 http://localhost:${NGINX_PORT}/v2/swap/submarine 2>/dev/null || echo "{}")
  if echo "$pairs" | grep -q '"ARK"'; then
    log "Boltz ARK/BTC pairs loaded successfully"
    break
  fi
  log "Waiting for Boltz pairs... (attempt $attempt/$max_attempts)"
  sleep 2
  ((attempt++))
done
if [ $attempt -gt $max_attempts ]; then
  log "ERROR: Boltz ARK/BTC pairs not available after restart"
  exit 1
fi

# ── Emulator (arkade-script signing service, default-on) ────────────────────
# Default-on; consumers opt out by setting EMULATOR_IMAGE= (empty) in their
# `.env` override. Comes up after arkd is wallet-ready because
# EMULATOR_ARKD_URL must resolve to a live arkd that accepts SubmitTx — the
# emulator forwards the finalized arkade tx to it.
if [ -n "${EMULATOR_IMAGE:-}" ]; then
  if docker ps --format '{{.Names}}' | grep -q '^emulator$'; then
    log "Emulator already running, skipping..."
  else
    log "Starting emulator overlay ($EMULATOR_IMAGE)..."
    docker compose -f "$SCRIPT_DIR/docker/docker-compose.emulator.yml" pull
    docker compose -f "$SCRIPT_DIR/docker/docker-compose.emulator.yml" up -d

    log "Waiting for emulator /v1/info..."
    max_attempts=30
    attempt=1
    while [ $attempt -le $max_attempts ]; do
      if curl -sf --max-time 3 "http://localhost:${EMULATOR_PORT}/v1/info" >/dev/null 2>&1; then
        log "Emulator is up at http://localhost:${EMULATOR_PORT}"
        emu_pubkey=$(curl -s "http://localhost:${EMULATOR_PORT}/v1/info" | jq -r '.signerPubkey // empty')
        log "Emulator signerPubkey: $emu_pubkey"
        break
      fi
      log "Waiting for emulator... (attempt $attempt/$max_attempts)"
      sleep 2
      ((attempt++))
    done
    if [ $attempt -gt $max_attempts ]; then
      log "ERROR: Emulator failed to respond on /v1/info"
      log "=== emulator logs (last 30 lines) ==="
      docker logs emulator 2>&1 | tail -30
      exit 1
    fi
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo " Regtest environment ready"
echo "========================================"
echo ""
echo "  Bitcoin RPC     http://localhost:18443"
echo "  Esplora         http://localhost:3000"
echo "  Arkd            http://localhost:7070"
echo "  Ark Wallet      http://localhost:6060"
echo "  Fulmine HTTP    http://localhost:${FULMINE_HTTP_PORT}"
echo "  Fulmine API     http://localhost:${FULMINE_API_PORT}"
echo "  Delegator gRPC  localhost:${DELEGATOR_GRPC_PORT}"
echo "  Delegator API   http://localhost:${DELEGATOR_API_PORT}"
echo "  Delegator HTTP  http://localhost:${DELEGATOR_HTTP_PORT}"
echo "  Boltz CORS      http://localhost:${NGINX_PORT}  (nginx proxy)"
echo "  Boltz gRPC      localhost:${BOLTZ_GRPC_PORT}"
echo "  Boltz LND       localhost:${BOLTZ_LND_RPC_PORT}"
echo ""
echo "  Ark container:  ${ARK_CONTAINER}"
echo "  Arkd password:  ${ARKD_PASSWORD}"
if [ -n "${ARKD_IMAGE:-}" ]; then
  echo "  Arkd image:     ${ARKD_IMAGE}"
fi
if [ -n "${EMULATOR_IMAGE:-}" ]; then
  echo "  Emulator        http://localhost:${EMULATOR_PORT}"
  echo "  Emulator image: ${EMULATOR_IMAGE}"
fi
echo ""
