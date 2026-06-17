// Operator signer-key rotation for arkade-regtest.
//
// Simulates an arkd operator rotating its VTXO signer key: generate a new active
// key and (optionally) advertise the previous one as a DEPRECATED signer with a
// cutoff date. arkd reads its signer set from arkd-wallet's
// ARKD_WALLET_SIGNER_KEY (active) + ARKD_WALLET_DEPRECATED_SIGNER_KEYS
// (`<hexpriv>[:<unix-seconds cutoff>],...`) env, so a rotation = recreate
// arkd-wallet with the new env (reusing its on-chain volume) + restart arkd so
// it re-reads the set. Requires the rc arkd/arkd-wallet images — deprecated-
// signer support landed after v0.9.6.
//
// The CLI persists the keys IT has applied (.signer-state.json) so a later
// rotation can move the current active key into the deprecated set: arkd needs
// the deprecated PRIVATE key to co-sign migration of pre-rotation funds. The
// very first rotation from an arkd-wallet-generated key cannot deprecate it (its
// private key was never CLI-managed); rotate again to deprecate a CLI key.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.mjs';
import { log, fail } from '../log.mjs';
import { sleep, waitFor, fetchJson, fetchText } from '../wait.mjs';
import { compose, ROOT } from '../compose.mjs';
import { docker } from '../proc.mjs';

// Wiped by `clean` (which also wipes arkd-wallet's volume, resetting the signer).
const STATE_FILE = join(ROOT, '.signer-state.json');

// The regtest's default active signer key — must match compose.ark.yml's
// ARKD_WALLET_SIGNER_KEY default. Because the wallet boots with this KNOWN key
// (rather than self-generating one), the very first rotation can advertise it as
// a deprecated signer: arkd needs the deprecated PRIVATE key, and this one is
// known. Seeded into the initial state below.
const DEFAULT_SIGNER_KEY = 'afcd3fa10f82a05fddc9574fdb13b3991b568e89cc39a72ba4401df8abef35f0';

const arkdUrl = () => `http://localhost:${env('ARKD_PORT', '7070')}`;
const arkdAdminUrl = () => `http://localhost:${env('ARKD_ADMIN_PORT', '7071')}`;

// /v1/info may report a 33-byte (compressed, 66-hex) or x-only (64-hex) pubkey;
// normalize to x-only so pre/post-rotation comparisons line up regardless.
function toXOnly(pub) {
  const s = String(pub || '').toLowerCase();
  return s.length === 66 ? s.slice(2) : s;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { active: DEFAULT_SIGNER_KEY, deprecated: [] };
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {
      active: s.active || DEFAULT_SIGNER_KEY,
      deprecated: Array.isArray(s.deprecated) ? s.deprecated : [],
    };
  } catch {
    return { active: DEFAULT_SIGNER_KEY, deprecated: [] };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

export function clearSignerState() {
  try {
    rmSync(STATE_FILE, { force: true });
  } catch {
    /* best-effort: nothing to clean up */
  }
}

async function getInfo() {
  const { json } = await fetchJson(`${arkdUrl()}/v1/info`);
  return json || {};
}

// arkd parses each deprecated entry as `<hexpriv>[:<unix-seconds cutoff>]`.
function encodeDeprecated(deprecated) {
  return deprecated.map((d) => (d.cutoff != null ? `${d.priv}:${d.cutoff}` : d.priv)).join(',');
}

function printSet(info) {
  log(`Active signer:      ${info.signerPubkey || info.pubkey || '(none)'}`);
  const dep = info.deprecatedSigners || [];
  if (!dep.length) {
    log('Deprecated signers: none');
    return;
  }
  for (const d of dep) {
    const c = d.cutoffDate;
    const tag = c && String(c) !== '0' ? `cutoff ${c}` : 'no cutoff (DUE_NOW)';
    log(`  deprecated:       ${d.pubkey} (${tag})`);
  }
}

export async function signerInfo() {
  printSet(await getInfo());
}

// Recreate ONLY arkd-wallet with the given signer set. docker()/compose() spawn
// with process.env, so setting the vars here is what compose interpolates into
// the service.
function recreateArkdWallet(active, deprecated) {
  process.env.ARKD_WALLET_SIGNER_KEY = active;
  process.env.ARKD_WALLET_DEPRECATED_SIGNER_KEYS = encodeDeprecated(deprecated);

  // NEVER pass --volumes: the named ark_wallet_datadir holds the on-chain wallet
  // seed/state, which must survive. --no-deps leaves bitcoin/nbxplorer alone.
  const up = compose(['up', '-d', '--force-recreate', '--no-deps', 'arkd-wallet'], {
    profiles: ['base', 'ark'],
  });
  if (up.code !== 0) fail(`failed to recreate arkd-wallet: ${up.stderr || up.stdout}`);
}

// Unlock arkd's wallet via the admin API. A freshly-recreated arkd-wallet comes
// up LOCKED, and arkd's env auto-unlocker only fires at arkd startup — not when
// the wallet is swapped under a still-running arkd — so after a recreate we must
// unlock explicitly or arkd can't read the (rotated) signer set. Best-effort: a
// no-op if already unlocked. (Matches arkd's own e2e recreateArkdWallet.)
async function unlockArkd() {
  await fetchText(`${arkdAdminUrl()}/v1/admin/wallet/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: env('ARKD_PASSWORD', 'secret') }),
  });
}

// Retry the unlock until arkd reports synced — i.e. it has (re)connected to an
// unlocked arkd-wallet, so its signer view is current. "synced" is the readiness
// signal; polling it (instead of sleeping a fixed worst case) makes a rotation
// only as slow as the wallet actually takes to come back. The freshly-recreated
// wallet boots LOCKED and may still be booting, so we re-issue the (best-effort)
// unlock on every poll until it takes and arkd reports synced.
async function unlockArkdUntilSynced(label) {
  const ok = await waitFor(
    label,
    async () => {
      await unlockArkd();
      const { json } = await fetchJson(`${arkdAdminUrl()}/v1/admin/wallet/status`);
      return Boolean(json && json.synced);
    },
    { attempts: 60, intervalMs: 2000 },
  );
  if (!ok) fail(`${label}: arkd wallet did not become ready (synced) in time`);
}

// Apply a signer set and make arkd serve it. arkd caches its signer set at
// process startup and does NOT refresh on a mere reconnect, so we must restart
// arkd — but only AFTER arkd-wallet is fully back AND unlocked. Restarting arkd
// while the wallet is still booting/locked makes arkd cache a partial set (or
// none). So: recreate the wallet, wait until arkd re-syncs to it (unlocked),
// THEN restart arkd so it re-fetches the complete set, and wait until synced
// again. Driven by readiness polls (unlockArkdUntilSynced) rather than fixed
// worst-case sleeps — a rotation is then only as slow as the wallet takes to
// return, which matters because the e2e wallet's subscription is disrupted for
// this whole window. (Mirrors arkd's own e2e recreateArkdWallet.)
async function applyAndRestart(active, deprecated) {
  recreateArkdWallet(active, deprecated);
  // Brief settle so arkd registers the wallet swap (status flips away from
  // synced) before we poll — avoids a stale "synced" read from the old wallet.
  await sleep(3000);
  await unlockArkdUntilSynced('arkd to re-sync to the recreated wallet');
  // `docker stop` blocks until arkd is down, so no settle is needed before
  // starting it again; the post-restart readiness poll covers arkd's boot.
  docker(['container', 'stop', 'arkd']);
  docker(['container', 'start', 'arkd']);
  await unlockArkdUntilSynced('arkd to restart and re-sync');
}

export async function rotateSigner({ cutoff, newKey } = {}) {
  const pre = await getInfo();
  const preActive = toXOnly(pre.signerPubkey || pre.pubkey || '');
  if (!preActive) {
    fail('arkd /v1/info exposes no signer — is the stack up with the `ark` profile? (node regtest.mjs start)');
  }

  const active = (newKey || randomBytes(32).toString('hex')).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(active)) fail('--new-key must be 32-byte hex (64 chars)');

  const state = loadState();
  // The current active signer (known: the regtest default or a previously
  // rotated CLI key) becomes a deprecated signer with the given cutoff.
  const deprecated = [
    ...state.deprecated,
    cutoff != null ? { priv: state.active, cutoff } : { priv: state.active },
  ];

  log(`Rotating active signer, deprecating the previous one${cutoff != null ? ` (cutoff ${cutoff})` : ''}...`);
  await applyAndRestart(active, deprecated);

  // Verify the rotation is observable: the active signer changed away from the
  // pre-rotation one, and (when we deprecated it) the old active pubkey is now
  // advertised as deprecated. Compared via /v1/info — no client-side key math.
  const ok = await waitFor(
    'arkd to advertise the rotated signer',
    async () => {
      const info = await getInfo();
      const now = toXOnly(info.signerPubkey || info.pubkey || '');
      if (!now || now === preActive) return false;
      // The just-deprecated key (the pre-rotation active) must now be advertised.
      const dep = new Set((info.deprecatedSigners || []).map((d) => toXOnly(d.pubkey)));
      if (!dep.has(preActive)) return false;
      return true;
    },
    { attempts: 45, intervalMs: 2000 },
  );
  if (!ok) {
    fail(
      'timed out waiting for the rotated signer set. The arkd/arkd-wallet images must support ' +
        'ARKD_WALLET_DEPRECATED_SIGNER_KEYS (use the rc images, e.g. v0.9.9-rc.1).',
    );
  }

  saveState({ active, deprecated });
  log('Signer rotation complete.');
  printSet(await getInfo());
}

// Apply an EXPLICIT signer set: the given active private key plus the given
// deprecated keys (each `{ priv, cutoff? }`). Unlike rotate-signer (which
// generates + tracks keys), the caller controls every key and cutoff — used by
// ts-sdk's e2e `rotateArkdSigner` helper to set a precise set.
export async function setSigners({ active, deprecated = [] } = {}) {
  const activeKey = String(active || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(activeKey)) {
    fail('set-signers: --active must be a 32-byte hex private key (64 chars)');
  }
  for (const d of deprecated) {
    if (!/^[0-9a-f]{64}$/.test(d.priv)) {
      fail(`set-signers: deprecated keys must be 32-byte hex private keys; got "${d.priv}"`);
    }
  }

  log(`Applying signer set: 1 active + ${deprecated.length} deprecated...`);
  await applyAndRestart(activeKey, deprecated);

  // Verify arkd advertises the new set. We compare COUNTS, not exact pubkeys
  // (the CLI is zero-dependency and can't derive pubkeys from privs); a caller
  // needing exact-key assertions does them against /v1/info itself.
  const ok = await waitFor(
    'arkd to advertise the signer set',
    async () => {
      const info = await getInfo();
      const now = toXOnly(info.signerPubkey || info.pubkey || '');
      return Boolean(now) && (info.deprecatedSigners || []).length === deprecated.length;
    },
    { attempts: 45, intervalMs: 2000 },
  );
  if (!ok) {
    fail(
      'set-signers: timed out waiting for arkd to advertise the signer set. The arkd/arkd-wallet ' +
        'images must support ARKD_WALLET_DEPRECATED_SIGNER_KEYS (use the rc images, e.g. v0.9.9-rc.1).',
    );
  }

  saveState({ active: activeKey, deprecated });
  log('Signer set applied.');
  printSet(await getInfo());
}
