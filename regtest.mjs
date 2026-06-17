#!/usr/bin/env node
// arkade-regtest orchestrator — cross-platform, zero-dependency.
//
//   node regtest.mjs start [--env <path>] [--clean] [--profile <name>...]
//   node regtest.mjs stop
//   node regtest.mjs clean [--prune]
//   node regtest.mjs faucet <address> <amountBtc>
//   node regtest.mjs mine [n]
//   node regtest.mjs rpc <args...>     (bitcoin-cli passthrough, in the bitcoin container)
//   node regtest.mjs rotate-signer [--cutoff <secs>] [--new-key <hex>]  (rotate operator signer; deprecate the previous)
//   node regtest.mjs set-signers --active <priv> [--deprecated <priv>[:<cutoff>],...]  (apply an explicit signer set)
//   node regtest.mjs signer-info       (print the active + deprecated signer set)
//
// Profiles (and their dependencies) let you bring up a subset of the stack:
//   ark → base,  delegate → ark,  boltz → ark,  emulator → ark,
//   solver → ark + emulator. `--profile boltz` brings up base+ark+boltz.
//   Selection precedence: --profile flags > REGTEST_PROFILES env (comma-list)
//   > full stack.
//
// Replaces the old bash scripts + the nigiri binary entirely.
import { loadEnv, env } from './lib/env.mjs';
import { log, warn, fail } from './lib/log.mjs';
import { ROOT, composeUp, composeStop, composeDown, ALL_PROFILES } from './lib/compose.mjs';
import { docker } from './lib/proc.mjs';
import { sleep, waitForOrFail, httpOk, fetchJson } from './lib/wait.mjs';
import { bitcoinCli, bootstrapChain, mine, faucet, reorg } from './lib/chain.mjs';
import { setupArkd, applyArkdFees } from './lib/setup/arkd.mjs';
import { setupFulmine, setupDelegator } from './lib/setup/fulmine.mjs';
import { setupBoltz } from './lib/setup/boltz.mjs';
import { setupSolver } from './lib/setup/solver.mjs';
import { createInvoice, payInvoice } from './lib/invoice.mjs';
import { rotateSigner, setSigners, signerInfo, clearSignerState } from './lib/setup/signer.mjs';

// Each profile's direct prerequisites. resolveProfiles() expands the transitive
// closure so the orchestrator can enable every profile a target tier needs.
const PROFILE_DEPS = {
  base: [],
  ark: ['base'],
  delegate: ['ark'], // standalone fulmine-delegator
  boltz: ['ark'], // boltz + its own boltz-fulmine + boltz-lnd (independent of the delegator)
  emulator: ['ark'],
  solver: ['ark', 'emulator'],
};

function resolveProfiles(requested) {
  const out = new Set();
  const visit = (p) => {
    if (out.has(p)) return;
    if (!(p in PROFILE_DEPS)) {
      fail(`unknown profile "${p}" (valid: ${Object.keys(PROFILE_DEPS).join(', ')})`);
    }
    out.add(p);
    PROFILE_DEPS[p].forEach(visit);
  };
  requested.forEach(visit);
  return [...out];
}

function parseArgs(argv) {
  const opts = { command: argv[0], env: '', clean: false, prune: false, confirm: false, cutoff: undefined, newKey: undefined, active: undefined, deprecated: undefined, profiles: [], positional: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--env') opts.env = argv[++i] || fail('--env requires a path');
    else if (a === '--clean') opts.clean = true;
    else if (a === '--prune') opts.prune = true;
    else if (a === '--confirm') opts.confirm = true;
    else if (a === '--profile') {
      const val = argv[++i] || fail('--profile requires a name');
      opts.profiles.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
    }
    else if (a === '--cutoff') opts.cutoff = argv[++i] || fail('--cutoff requires a value (unix seconds, or +N/-N seconds from now)');
    else if (a === '--new-key') opts.newKey = argv[++i] || fail('--new-key requires a 32-byte hex value');
    else if (a === '--active') opts.active = argv[++i] || fail('--active requires a 32-byte hex private key');
    else if (a === '--deprecated') opts.deprecated = argv[++i] ?? fail('--deprecated requires <priv>[:<cutoff>],...');
    else if (a === '--build') { /* legacy no-op: there is no build artifact anymore */ }
    else opts.positional.push(a);
  }
  return opts;
}

// Resolve a --cutoff CLI value to a Unix-seconds timestamp for arkd. An absolute
// value (e.g. 1781344800) is used as-is; a signed value (+N / -N) is N seconds
// from now (future => MIGRATABLE, past => EXPIRED). Absent => no cutoff (DUE_NOW).
function resolveCutoff(raw) {
  if (raw == null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    fail(`--cutoff must be a number: unix seconds (e.g. 1781344800) or +N/-N seconds from now (got "${raw}")`);
  }
  const relative = /^[+-]/.test(String(raw).trim());
  return relative ? Math.floor(Date.now() / 1000) + n : Math.trunc(n);
}

async function startEmulator() {
  if (!env('EMULATOR_IMAGE')) {
    log('Emulator disabled (EMULATOR_IMAGE empty), skipping...');
    return;
  }
  const port = env('EMULATOR_PORT', '7073');
  log(`Starting emulator overlay (${env('EMULATOR_IMAGE')})...`);
  composeUp(['emulator'], { profiles: ['emulator'] });
  await waitForOrFail('emulator /v1/info', () => httpOk(`http://localhost:${port}/v1/info`));
  const { json } = await fetchJson(`http://localhost:${port}/v1/info`);
  log(`Emulator up at http://localhost:${port} (signerPubkey: ${json?.signerPubkey || '?'})`);
}

function banner(active) {
  const lines = [
    '',
    '========================================',
    ' Regtest environment ready',
    '========================================',
    '',
    `  Bitcoin RPC     http://localhost:${env('BITCOIN_RPC_PORT', '18443')}  (admin1 / 123)`,
    `  Mempool / API   http://localhost:${env('MEMPOOL_WEB_PORT', '3000')}  (Esplora REST under /api)`,
    `  Fulcrum         localhost:${env('FULCRUM_TCP_PORT', '50001')}`,
    `  NBXplorer       http://localhost:${env('NBXPLORER_PORT', '32838')}`,
    `  Postgres        localhost:${env('POSTGRES_PORT', '39372')}  (trust auth; DBs: arkd, nbxplorer)`,
  ];
  if (active.has('ark')) {
    lines.push(`  Arkd            http://localhost:${env('ARKD_PORT', '7070')}   (admin :${env('ARKD_ADMIN_PORT', '7071')})`);
    lines.push(`  Arkd Wallet     http://localhost:${env('ARKD_WALLET_PORT', '6060')}`);
    lines.push(`  Web Wallet      http://localhost:${env('WALLET_PORT', '3003')}`);
    lines.push(`  Explorer        http://localhost:${env('EXPLORER_PORT', '7080')}`);
  }
  if (active.has('delegate')) {
    lines.push(`  Delegator API   http://localhost:${env('DELEGATOR_API_PORT', '7011')}`);
  }
  if (active.has('boltz')) {
    lines.push(`  Fulmine API     http://localhost:${env('FULMINE_API_PORT', '7003')}`);
    lines.push(`  Boltz LND       localhost:${env('BOLTZ_LND_RPC_PORT', '10010')}`);
    lines.push(`  Boltz CORS      http://localhost:${env('NGINX_PORT', '9069')}`);
    lines.push(`  Boltz gRPC      localhost:${env('BOLTZ_GRPC_PORT', '9000')}`);
  }
  if (active.has('emulator')) {
    lines.push(`  Emulator        http://localhost:${env('EMULATOR_PORT', '7073')}`);
  }
  if (active.has('solver')) {
    lines.push(`  Solver HTTP     http://localhost:${env('SOLVER_HTTP_PORT', '7091')}`);
    lines.push(`  Solver gRPC     localhost:${env('SOLVER_GRPC_PORT', '7090')}`);
  }
  lines.push(
    '',
    `  Active profiles: ${[...active].join(', ')}`,
    `  Arkd password:   ${env('ARKD_PASSWORD', 'secret')}`,
    '',
  );
  console.log(lines.join('\n'));
}

async function start(opts) {
  if (opts.clean) await clean(opts);

  // Profile selection precedence: --profile flags > REGTEST_PROFILES env > all.
  const fromEnv = env('REGTEST_PROFILES')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const requested = opts.profiles.length ? opts.profiles : fromEnv.length ? fromEnv : ALL_PROFILES;
  const active = new Set(resolveProfiles(requested));

  // Emulator opt-out: clearing EMULATOR_IMAGE disables it — and the solver,
  // which requires the emulator (SOLVER_EMULATOR_URL).
  if (!env('EMULATOR_IMAGE')) {
    if (active.delete('emulator')) log('Emulator disabled (EMULATOR_IMAGE empty)');
    if (active.delete('solver')) warn('Solver needs the emulator; skipping it (EMULATOR_IMAGE is empty)');
  }

  const profiles = [...active];
  log(`Starting arkade-regtest stack (profiles: ${profiles.join(', ')})...`);
  const up = composeUp([], { profiles });
  if (up.code !== 0) fail('docker compose up failed');

  // base (always in any closure): wait for bitcoind RPC, fund the node wallet,
  // and wait for the explorer's Esplora API before anything tries to sync.
  await waitForOrFail('Bitcoin Core RPC', () =>
    bitcoinCli(['getblockchaininfo'], { capture: true }).code === 0,
  );
  await bootstrapChain();
  await waitForOrFail('mempool Esplora API', () =>
    httpOk(`http://localhost:${env('MEMPOOL_WEB_PORT', '3000')}/api/blocks/tip/height`),
    { attempts: 60, intervalMs: 3000 },
  );

  if (active.has('ark')) await setupArkd();
  if (active.has('delegate')) await setupDelegator();
  if (active.has('boltz')) {
    await setupFulmine(); // boltz-fulmine lives in the boltz profile
    await setupBoltz();
  }
  if (active.has('emulator')) await startEmulator();
  if (active.has('solver')) await setupSolver();
  // Apply the configured arkd intent fees last — every wallet above settles/
  // redeems with fees zeroed, so this must run after all of them.
  if (active.has('ark')) await applyArkdFees();

  banner(active);
}

async function stop() {
  log('Stopping arkade-regtest stack (data preserved)...');
  composeStop();
  log('Environment stopped.');
}

async function clean(opts) {
  log('Removing arkade-regtest containers and volumes...');
  composeDown({ volumes: true });
  // arkd-wallet's volume is gone, so the persisted signer set no longer applies.
  clearSignerState();
  if (opts.prune) {
    log('Pruning dangling images and volumes...');
    docker(['image', 'prune', '-f']);
    docker(['volume', 'prune', '-f']);
  }
  log('Clean-up complete.');
}

async function main() {
  const argv = process.argv.slice(2);

  // `ark` / `arkd` are raw passthroughs into the arkd container, so forward
  // every following token verbatim (flags included) without our own parsing.
  if (argv[0] === 'ark' || argv[0] === 'arkd') {
    const res = docker(['exec', 'arkd', ...argv]); // argv[0] is the binary name in the container
    process.exitCode = res.code;
    return;
  }

  // `rpc` is a bitcoin-cli passthrough into the bitcoin container — the in-house
  // replacement for `nigiri rpc`. So `node regtest.mjs rpc getblockcount` maps to
  // `bitcoin-cli -regtest … getblockcount`, keeping downstream migrations a
  // find-replace (`nigiri rpc …` → `node regtest.mjs rpc …`, same arg shape).
  if (argv[0] === 'rpc') {
    const res = docker(['exec', 'bitcoin', 'bitcoin-cli', '-regtest', '-rpcuser=admin1', '-rpcpassword=123', ...argv.slice(1)]);
    process.exitCode = res.code;
    return;
  }

  const opts = parseArgs(argv);
  if (!opts.command) {
    fail('usage: node regtest.mjs <start|stop|clean|faucet|mine|reorg|rpc|ark|arkd|rotate-signer|set-signers|signer-info> [options]');
  }

  // faucet/mine act on a running node and don't need override discovery, but
  // loading env is harmless and keeps ports/keys consistent.
  loadEnv(ROOT, opts.env);

  switch (opts.command) {
    case 'start':
      await start(opts);
      break;
    case 'stop':
      await stop();
      break;
    case 'clean':
      await clean(opts);
      break;
    case 'faucet': {
      const [address, amount] = opts.positional;
      if (!address || !amount) fail('usage: node regtest.mjs faucet <address> <amountBtc> [--confirm]');
      if (!faucet(address, amount, { confirm: opts.confirm })) fail('faucet failed');
      log(`Sent ${amount} BTC to ${address}${opts.confirm ? ' and mined 1 block' : ' (unconfirmed; mine to confirm)'}`);
      break;
    }
    case 'mine': {
      const n = parseInt(opts.positional[0] || '1', 10);
      if (!mine(n)) fail('mine failed');
      log(`Mined ${n} block(s)`);
      break;
    }
    case 'reorg': {
      const depth = parseInt(opts.positional[0] || '1', 10);
      if (!Number.isFinite(depth) || depth < 1) fail('usage: node regtest.mjs reorg [depth>=1]');
      if (!reorg(depth)) fail('reorg failed');
      log(`Reorged ${depth} block(s)`);
      break;
    }
    case 'create-invoice':
      createInvoice({ secondary: process.argv.includes('--secondary') });
      break;
    case 'pay-invoice':
      payInvoice(opts.positional[0]);
      break;
    case 'rotate-signer':
      await rotateSigner({ cutoff: resolveCutoff(opts.cutoff), newKey: opts.newKey });
      break;
    case 'signer-info':
      await signerInfo();
      break;
    case 'set-signers': {
      if (!opts.active) fail('usage: node regtest.mjs set-signers --active <priv> [--deprecated <priv>[:<cutoff>],...]');
      const deprecated = (opts.deprecated || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((entry) => {
          const sep = entry.indexOf(':');
          if (sep === -1) return { priv: entry.toLowerCase() };
          return { priv: entry.slice(0, sep).toLowerCase(), cutoff: resolveCutoff(entry.slice(sep + 1)) };
        });
      await setSigners({ active: opts.active, deprecated });
      break;
    }
    default:
      fail(`unknown command: ${opts.command}`);
  }
}

main().catch((err) => {
  // fail() already printed marked errors; print anything unexpected.
  if (!err?.handled) {
    console.error(`\x1b[0;31m${err && err.stack ? err.stack : String(err)}\x1b[0m`);
  }
  process.exitCode = 1;
});
