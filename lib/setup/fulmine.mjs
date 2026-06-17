// Fulmine + delegator wallet bring-up. Both are the same Fulmine image; the
// delegator just runs without LND/Boltz. One generalized helper covers both.
import { env } from '../env.mjs';
import { log, warn, fail } from '../log.mjs';
import { sleep, waitForOrFail, fetchJson, fetchText, httpOk } from '../wait.mjs';
import { mine } from '../chain.mjs';
import { dockerExec } from '../proc.mjs';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
// Docker-internal arkd URL stored in the Fulmine wallet at creation time.
// Coupled to the `arkd` service name in docker/compose.ark.yml — keep in sync
// if that service is ever renamed.
const ARK_SERVER = 'http://arkd:7070';

async function status(base) {
  const { json } = await fetchJson(`${base}/api/v1/wallet/status`);
  return json || {};
}

// label: human name for logs; port: host API port; noteAmount: sats to fund with.
async function setupWallet({ label, port, noteAmount }) {
  const base = `http://localhost:${port}`;

  const existing = await status(base).catch(() => ({}));
  if (existing.initialized) {
    log(`${label} wallet already initialized, skipping...`);
    return;
  }

  await waitForOrFail(`${label} service`, () =>
    httpOk(`${base}/api/v1/wallet/status`),
  );

  log(`Creating ${label} wallet...`);
  const { json: seedResp } = await fetchJson(`${base}/api/v1/wallet/genseed`);
  const privateKey = seedResp && seedResp.nsec;
  if (!privateKey) fail(`${label}: failed to generate seed`);

  await fetchText(`${base}/api/v1/wallet/create`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ private_key: privateKey, password: 'password', server_url: ARK_SERVER }),
  });
  await fetchText(`${base}/api/v1/wallet/unlock`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ password: 'password' }),
  });

  await waitForOrFail(`${label} wallet ready`, async () => {
    const s = await status(base);
    return s.initialized === true && s.synced === true && s.unlocked === true;
  });

  // Fund offchain by redeeming a server-issued credit note. This is immediate
  // and reliable; the alternative (faucet a boarding address + /settle) depends
  // on boarding-UTXO detection and round timing and routinely lands 0 balance.
  // The redeem joins a round, so it registers an intent that must cover the
  // offchain input fee — start() keeps intent fees zeroed through the whole
  // funding phase and applies the real fees last.
  log(`Funding ${label} wallet via a credit note (${noteAmount} sats)...`);
  const note = dockerExec('arkd', ['arkd', 'note', '--amount', String(noteAmount)], { capture: true }).stdout.trim();
  if (!note) {
    warn(`${label}: failed to create credit note; wallet left unfunded`);
  } else {
    const redeem = await fetchText(`${base}/api/v1/note/redeem`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ note }),
      timeoutMs: 60000,
    });
    if (!redeem.ok) warn(`${label} note redeem failed: HTTP ${redeem.status} ${redeem.text}`);
  }
  mine(3); // confirm the round commitment tx
  await sleep(3000);

  log(`${label} wallet setup completed`);
}

export async function setupFulmine() {
  await setupWallet({
    label: 'Fulmine',
    port: env('FULMINE_API_PORT', '7003'),
    noteAmount: env('FULMINE_NOTE_AMOUNT', '100000000'),
  });
}

export async function setupDelegator() {
  await setupWallet({
    label: 'Delegator',
    port: env('DELEGATOR_API_PORT', '7011'),
    noteAmount: env('FULMINE_NOTE_AMOUNT', '100000000'),
  });
}
