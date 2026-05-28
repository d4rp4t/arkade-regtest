# arkade-regtest

A self-contained regtest environment for Ark protocol development. It orchestrates Nigiri (Bitcoin + Liquid regtest), arkd, Fulmine, Boltz, and an LND node into a single reproducible stack using Docker Compose. Intended to be embedded as a git submodule in projects that need a local Ark test network.

## Quick start

```bash
# Start the environment
./start-env.sh

# Stop all services (preserves data)
./stop-env.sh

# Stop and remove all containers, volumes, and build artifacts
./clean-env.sh
```

## Configuration

All defaults live in `.env.defaults`. The script auto-discovers overrides in this priority order:

1. `--env <path>` flag (explicit, highest priority)
2. `../.env.regtest` (parent repo override — typical submodule case)
3. `.env` (local override in arkade-regtest itself)

Variables in the override file replace their `.env.defaults` counterparts; unspecified variables keep their defaults.

### Custom arkd version

To use a specific arkd version instead of nigiri's built-in one, set `ARKD_IMAGE` and `ARKD_WALLET_IMAGE` in your override file:

```bash
ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.9.0
ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.9.0
```

When set, `start-env.sh` stops nigiri's arkd and starts these images instead.

### Emulator (arkade-script signing service)

The [arkade-os/emulator](https://github.com/arkade-os/emulator) service validates arkade-script covenants on Ark transactions and signs the matching script-tweaked key. Enable it by setting `EMULATOR_IMAGE` in your override file:

```bash
EMULATOR_IMAGE=ghcr.io/arkade-os/emulator:v0.0.1
```

When set, `start-env.sh` brings the emulator up on the nigiri network after arkd is wallet-ready, exposes it at `http://localhost:${EMULATOR_PORT}` (default `7073`), and waits for `GET /v1/info` to respond before returning. The signing key is configured via `EMULATOR_SECRET_KEY`; the corresponding x-only pubkey is reported in the startup banner and on the info endpoint, so tests can pin to it.

The emulator is opt-in because most regtest consumers don't use arkade-script — leaving `EMULATOR_IMAGE` empty keeps the default boot fast.

## Nigiri resolution

By default, Nigiri is built from source using the `bump-arkd` branch (`NIGIRI_BRANCH` in `.env.defaults`). This ensures all consumers use the exact same version with Ark support.

To use a system-installed nigiri instead, set `NIGIRI_BRANCH=""` in your `.env` override. The script will then use whatever `nigiri` binary is on `$PATH`.

## Service URLs

| Service          | URL / endpoint              | Default port |
| ---------------- | --------------------------- | ------------ |
| Boltz LND P2P    | `localhost:9736`            | 9736         |
| Boltz LND RPC    | `localhost:10010`           | 10010        |
| Fulmine HTTP     | `localhost:7002`            | 7002         |
| Fulmine API      | `localhost:7003`            | 7003         |
| Boltz gRPC       | `localhost:9000`            | 9000         |
| Boltz REST API   | `localhost:9001`            | 9001         |
| Boltz WebSocket  | `localhost:9004`            | 9004         |
| Nginx            | `localhost:9069`            | 9069         |
| Emulator         | `localhost:7073` (opt-in)   | 7073         |

Nigiri's own services (electrs, esplora, chopsticks, arkd) use their standard ports. See the Nigiri documentation for details.

## Helper scripts

- **`create-invoice.sh`** -- Creates a Lightning invoice on the Boltz LND node. Useful for testing payment flows through Boltz swaps.
- **`pay-invoice.sh`** -- Pays a Lightning invoice from the Boltz LND node. Useful for testing receive flows and Boltz reverse swaps.

## Using as a git submodule

Add arkade-regtest to your project:

```bash
git submodule add https://github.com/arkade-os/arkade-regtest.git regtest
```

Create `.env.regtest` in your repo root to override defaults:

```bash
# Pin specific arkd version
ARKD_IMAGE=ghcr.io/arkade-os/arkd:v0.9.0
ARKD_WALLET_IMAGE=ghcr.io/arkade-os/arkd-wallet:v0.9.0
```

Start the environment:

```bash
./regtest/start-env.sh
```

The script auto-discovers `../.env.regtest` from the parent directory.

See `.env.defaults` for all available configuration options.

### CI integration

```yaml
- uses: actions/checkout@v4
  with:
    submodules: true

- uses: actions/setup-go@v5
  with:
    go-version: '1.23'

- uses: actions/cache@v4
  with:
    path: regtest/_build
    key: nigiri-${{ hashFiles('regtest/.env.defaults', '.env.regtest') }}

- name: Start regtest environment
  run: ./regtest/start-env.sh

- name: Run tests
  run: <your test command>

- name: Cleanup
  if: always()
  run: ./regtest/clean-env.sh
```
