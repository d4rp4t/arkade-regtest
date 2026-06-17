# arkade-regtest

A self-contained, cross-platform regtest environment for Ark protocol development. It orchestrates Bitcoin Core, Fulcrum, mempool, NBXplorer, arkd, Fulmine, Boltz, and an LND node into a single reproducible Docker Compose stack — driven by a small zero-dependency Node CLI.

There is **no dependency on nigiri** and **no compiled binary** to maintain: everything is standard Docker images plus a Node orchestrator. It runs the same on Linux, macOS, and Windows (no WSL required).

## Requirements

- **Docker** + the **`docker compose`** plugin
- **Node.js >= 18** (uses only the standard library — no `npm install` needed)

## Quick start

```bash
# Start the whole environment
node regtest.mjs start

# Stop all services (preserves data)
node regtest.mjs stop

# Stop and remove all containers + volumes
node regtest.mjs clean
```

The lifecycle commands have npm aliases too, so from inside this repo you can use either form:

```bash
npm start        # = node regtest.mjs start
npm stop         # = node regtest.mjs stop
npm run clean    # = node regtest.mjs clean
```

Use **`node regtest.mjs`** for the argument-taking commands below (npm would need the awkward `npm run … -- <args>` form), and whenever this repo is embedded as a submodule (`node regtest/regtest.mjs start`).

### Other commands

```bash
node regtest.mjs faucet <address> <amountBtc> [--confirm]   # send from the node wallet; --confirm mines 1
node regtest.mjs mine [n]                        # mine n blocks (default 1)
node regtest.mjs reorg [depth]                   # simulate a reorg of `depth` blocks (default 1)
node regtest.mjs rpc <args...>                   # bitcoin-cli passthrough (replaces `nigiri rpc`)
node regtest.mjs create-invoice [--secondary]    # 100k-sat invoice (boltz-lnd, or lnd)
node regtest.mjs pay-invoice <invoice>           # pay from the non-destination node
node regtest.mjs ark <args...>                   # ark client CLI, run inside the arkd container
node regtest.mjs arkd <args...>                  # arkd server CLI, run inside the arkd container
node regtest.mjs rotate-signer [--cutoff <secs>] # rotate the operator signer; deprecate the previous key
node regtest.mjs signer-info                     # print the active + deprecated signer set
```

`start` initializes the `ark` client (pointed at the local arkd + mempool explorer) and seeds it with offchain funds, so commands like `node regtest.mjs ark balance` / `ark receive` / `ark send …` work out of the box. The `arkd` passthrough exposes the server CLI (e.g. `node regtest.mjs arkd note --amount 100000000`).

> **Block production.** A built-in auto-miner mines one block every `AUTOMINE_INTERVAL` seconds (default **600 / 10 min**); set `AUTOMINE_INTERVAL=0` to disable it and mine only explicitly. `faucet` spends from the node wallet's balance and does **not** confirm by default — pass `--confirm` to mine a block immediately, or rely on the auto-miner / an explicit `node regtest.mjs mine`. The `start` flow mines explicitly where it needs confirmed funds, so a fresh start is deterministic regardless of the auto-miner. Disable it (`AUTOMINE_INTERVAL=0`) when you configure arkd with block-denominated locktimes for fast expiry/sweep tests — see [Fast VTXO expiry & sweeps](#fast-vtxo-expiry--sweeps-block-denominated-locktimes) — so background mining can't advance the chain tip and fire sweeps mid-test.

## Architecture

Two compose files are merged into one project (`arkade-regtest`):

- **`docker/compose.base.yml`** — chain + indexers + explorer + counterparty LN:
  `bitcoin` (Bitcoin Core regtest), `postgres`, `nbxplorer`, `fulcrum` (Electrum server),
  `mempool_api` + `mempool_web` + `mempool_mariadb` (block explorer & Esplora REST API), and `lnd`.
- **`docker/compose.ark.yml`** — the Ark stack: `arkd` + `arkd-wallet`, `boltz`, `boltz-lnd`,
  `boltz-fulmine`, `fulmine-delegator`, `nginx-boltz`, `lnurl-server`, `arkade-wallet`, and the
  profile-gated `emulator`.

arkd and Fulmine consume the **Esplora-compatible REST API that mempool serves under `/api`**
(`http://mempool_web/api` inside the network) — an officially supported arkd explorer backend.

Bitcoin Core and the counterparty LND node use the BTCPay images, so their configuration is embedded directly via `BITCOIN_EXTRA_ARGS` / `LND_EXTRA_ARGS` in `compose.base.yml` — there are no bind-mounted conf files.

## Profiles

Services are grouped into compose profiles so you can bring up just the tier you need. The CLI resolves the dependency closure automatically:

| Profile    | Services                                                          | Depends on        |
| ---------- | ----------------------------------------------------------------- | ----------------- |
| `base`     | bitcoin, postgres, nbxplorer, fulcrum, mempool (api/web/db), lnd  | —                 |
| `ark`      | arkd, arkd-wallet, arkade-wallet, arkade-explorer                 | `base`            |
| `delegate` | fulmine-delegator                                                 | `ark`             |
| `boltz`    | boltz, boltz-fulmine, boltz-lnd, nginx-boltz, lnurl-server        | `ark`             |
| `emulator` | emulator                                                          | `ark`             |
| `solver`   | solver                                                            | `ark`, `emulator` |

```bash
node regtest.mjs start                      # full stack (all profiles)
node regtest.mjs start --profile base       # just the chain + explorer/indexer
node regtest.mjs start --profile ark        # base + ark (incl. web wallet + explorer)
node regtest.mjs start --profile boltz      # base + ark + boltz (incl. boltz-fulmine)
node regtest.mjs start --profile solver     # base + ark + emulator + solver
node regtest.mjs start --profile emulator --profile boltz   # combine targets
```

You can also pin profiles via the `REGTEST_PROFILES` env var (comma-separated, e.g. in `.env.regtest`) instead of passing `--profile`. Precedence: `--profile` flags > `REGTEST_PROFILES` > full stack.

`stop` and `clean` always act on the whole project regardless of profiles.

## Configuration

All defaults live in `.env.defaults`. Overrides are discovered in this priority order:

1. `--env <path>` (explicit, highest priority)
2. `../.env.regtest` (parent repo override — typical submodule case)
3. `.env` (local override in arkade-regtest itself)

Variables in the override file replace their `.env.defaults` counterparts; unspecified variables keep their defaults. A variable already set in your shell environment wins over the files.

### Host ports

Every host-exposed port is configurable via `${VAR:-default}` so you can avoid local collisions or run multiple stacks side by side — only the host side is remapped; container-internal ports stay fixed. Base layer: `BITCOIN_RPC_PORT` (18443), `BITCOIN_P2P_PORT` (18444), `BITCOIN_ZMQ_BLOCK_PORT` (28332), `BITCOIN_ZMQ_TX_PORT` (28333), `NBXPLORER_PORT` (32838), `POSTGRES_PORT` (39372), `FULCRUM_TCP_PORT` (50001), `FULCRUM_WS_PORT` (50003), `LND_P2P_PORT` (9735), `LND_RPC_PORT` (10009), `MEMPOOL_WEB_PORT` (3000). Ark layer: `ARKD_PORT` (7070), `ARKD_ADMIN_PORT` (7071), `ARKD_WALLET_PORT` (6060), plus the existing Fulmine/Boltz/solver port vars. The CLI reads `ARKD_PORT`/`ARKD_ADMIN_PORT` itself, so overriding them keeps `start`'s arkd setup pointed at the right host ports.

### Custom arkd version

arkd is always run from `ARKD_IMAGE` / `ARKD_WALLET_IMAGE` (there is no built-in fallback). The defaults are `v0.9.9-rc.1` — the [signer rotation](#operator-signer-rotation) feature needs the rc images, since deprecated-signer support landed after `v0.9.6`. Pin a different version in your override file:

```bash
ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.9.9-rc.1
ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.9.9-rc.1
```

### Operator signer rotation

Simulate an arkd operator rotating its VTXO **signer key**: generate a new active key and advertise the previous one as a *deprecated signer* with an optional cutoff date. This drives the client-side migration / recovery flows — clients must re-sign or recover VTXOs locked to a retired signer before its cutoff.

```bash
node regtest.mjs rotate-signer                 # new active key; deprecate the current one (no cutoff → DUE_NOW)
node regtest.mjs rotate-signer --cutoff +86400 # …deprecate with a cutoff 1 day in the future (MIGRATABLE)
node regtest.mjs rotate-signer --cutoff -3600  # …deprecate with a cutoff 1 hour in the past (EXPIRED)
node regtest.mjs rotate-signer --new-key <hex> # rotate to a specific 32-byte hex private key
node regtest.mjs set-signers --active <priv> --deprecated <priv>:<cutoff>,<priv>  # apply an EXPLICIT set
node regtest.mjs signer-info                   # print the active + deprecated signer set
```

`--cutoff` is a Unix-seconds timestamp, or a signed `+N` / `-N` offset in seconds from now. arkd classifies each deprecated signer by its cutoff: **no cutoff → DUE_NOW**, **future → MIGRATABLE**, **past → EXPIRED**.

`set-signers` applies a **precise** set rather than generating keys: `--active <priv>` plus a comma-separated `--deprecated <priv>[:<cutoff>],…` (each cutoff a Unix-seconds timestamp or `+N`/`-N` offset). It's the primitive the ts-sdk e2e drives rotation through; `rotate-signer` is the convenience wrapper that generates + tracks keys for you.

How it works: arkd reads its signer set from arkd-wallet's `ARKD_WALLET_SIGNER_KEY` (active) and `ARKD_WALLET_DEPRECATED_SIGNER_KEYS` (`<hexpriv>[:<cutoff>],…`) env, so a rotation recreates arkd-wallet with the new env (reusing its on-chain volume), unlocks it, and restarts arkd so it re-fetches the rotated set. The wallet boots from a **known default signer key** (`ARKD_WALLET_SIGNER_KEY` in `.env.defaults`) rather than self-generating one, and the CLI seeds `.signer-state.json` with it — so even the **first** rotation can advertise the boot signer as deprecated (arkd needs the deprecated **private** key to co-sign migration of pre-rotation funds). `clean` resets the signer set along with the wallet volume. Requires the rc images (see [Custom arkd version](#custom-arkd-version)).

### Fast VTXO expiry & sweeps (block-denominated locktimes)

arkd interprets `ARKD_VTXO_TREE_EXPIRY` and the exit delays (`ARKD_*_EXIT_DELAY`) **by magnitude** — the BIP68 boundary is **512** — and auto-selects its scheduler from the result:

| Value      | Interpreted as              | Scheduler           | Expiry / sweeps fire when…                                            |
| ---------- | --------------------------- | ------------------- | -------------------------------------------------------------------- |
| **≥ 512**  | seconds                     | time (wall-clock)   | the real-time deadline passes (the default `1024` ≈ 17 min)          |
| **< 512**  | **blocks** *(regtest only)* | block (polls the tip)| the chain **tip height** reaches the target — i.e. when you **mine** |

The block path is the "fast regtest" trick: set small values and trigger VTXO-tree expiry / sweeps **instantly by mining** instead of waiting real time (arkd's mainnet default is 7 days). arkd **rejects** block-denominated locktimes on any non-regtest network. These are arkd's own e2e values:

```bash
ARKD_VTXO_TREE_EXPIRY=40
ARKD_UNILATERAL_EXIT_DELAY=20
ARKD_PUBLIC_UNILATERAL_EXIT_DELAY=20
ARKD_BOARDING_EXIT_DELAY=30
ARKD_CHECKPOINT_EXIT_DELAY=10
AUTOMINE_INTERVAL=0   # required — see below
```

Two rules when using block values:

- **Disable the auto-miner** (`AUTOMINE_INTERVAL=0`). Otherwise the background miner advances the chain tip on its own and fires sweeps/expiry mid-test, making block-height-sensitive tests non-deterministic — mine explicitly with `node regtest.mjs mine <n>` instead.
- **All values must share the same type** (all blocks *or* all seconds). arkd validates this and refuses to start on a mismatch.

The default config above (`1024` etc., all ≥ 512) uses the **seconds / time** scheduler, so a default stack is unaffected by the auto-miner.

### Emulator (arkade-script signing service)

The [arkade-os/emulator](https://github.com/arkade-os/emulator) runs **by default** at `http://localhost:${EMULATOR_PORT}` (default `7073`). It is started last, after arkd is wallet-ready. Disable it for a faster boot by clearing the image in your override:

```bash
EMULATOR_IMAGE=
```

## Service URLs

| Service            | URL / endpoint                         | Default port |
| ------------------ | -------------------------------------- | ------------ |
| Bitcoin Core RPC   | `localhost:18443` (admin1 / 123)       | 18443        |
| Mempool explorer   | `http://localhost:3000`                | 3000         |
| Esplora REST API   | `http://localhost:3000/api`            | 3000         |
| Fulcrum (Electrum) | `localhost:50001` (TCP), `localhost:50003` (WS) | 50001 / 50003 |
| NBXplorer          | `http://localhost:32838`               | 32838        |
| Postgres           | `localhost:39372` (trust; DBs: arkd, nbxplorer) | 39372 |
| Arkd               | `http://localhost:7070` (admin `7071`) | 7070         |
| Arkd Wallet        | `http://localhost:6060`                | 6060         |
| Fulmine API        | `http://localhost:7003`                | 7003         |
| Delegator API      | `http://localhost:7011`                | 7011         |
| Boltz CORS proxy   | `http://localhost:9069`                | 9069         |
| Boltz gRPC         | `localhost:9000`                       | 9000         |
| Boltz LND RPC      | `localhost:10010`                      | 10010        |
| Web wallet         | `http://localhost:3003`                | 3003         |
| Arkade explorer    | `http://localhost:7080`                | 7080         |
| Emulator           | `http://localhost:7073`                | 7073         |
| Solver HTTP        | `http://localhost:7091`                | 7091         |
| Solver gRPC        | `localhost:7090`                       | 7090         |

## Using as a git submodule

```bash
git submodule add https://github.com/arkade-os/arkade-regtest.git regtest
```

Create `.env.regtest` in your repo root to override defaults, then:

```bash
node regtest/regtest.mjs start
```

The CLI auto-discovers `../.env.regtest` from the parent directory.

### CI integration

```yaml
- uses: actions/checkout@v4
  with:
    submodules: true

- uses: actions/setup-node@v4
  with:
    node-version: '20'

- name: Start regtest environment
  run: node regtest/regtest.mjs start

- name: Run tests
  run: <your test command>

- name: Cleanup
  if: always()
  run: node regtest/regtest.mjs clean
```

No build cache step is needed — the stack is pulled Docker images only.

## Migrating from the nigiri-based version

- Entry points changed: `./start-env.sh` → `node regtest.mjs start` (same for `stop` / `clean`). Update local usage and CI.
- The `NIGIRI_*` variables and the `_build/` cache are gone.
- The explorer/indexer is now Fulcrum + mempool instead of electrs + chopsticks + esplora. The Esplora REST API moved from `http://localhost:3000` (chopsticks root) to `http://localhost:3000/api` (mempool).
- There is no auto-miner — mine explicitly (see the note above).
