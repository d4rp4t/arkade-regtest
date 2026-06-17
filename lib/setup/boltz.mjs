// Boltz Lightning + swap bring-up: fund the boltz-lnd wallet, open a channel to
// the counterparty `lnd`, balance it, then fund Boltz's Bitcoin Core wallet and
// verify the ARK/BTC pairs are live.
import { env } from '../env.mjs';
import { log, warn, fail } from '../log.mjs';
import { sleep, waitFor, waitForOrFail, fetchText } from '../wait.mjs';
import { faucet, mine, bitcoinCli } from '../chain.mjs';
import { dockerExec } from '../proc.mjs';
import { compose } from '../compose.mjs';
import { lncli, lncliBase } from '../lnd.mjs';

function channelCount() {
  const { json } = lncli('boltz-lnd', ['listchannels']);
  return json && Array.isArray(json.channels) ? json.channels.length : 0;
}

async function setupLndChannel() {
  if (channelCount() > 0) {
    log('LND channel already open, skipping setup...');
    return;
  }

  log('Setting up LND for Lightning swaps...');
  await waitForOrFail('boltz-lnd wallet', () => lncli('boltz-lnd', ['getinfo']).ok);

  const addr = lncli('boltz-lnd', ['newaddress', 'p2wkh']).json?.address;
  if (!addr) fail('Could not get boltz-lnd address');
  log(`Funding boltz-lnd at ${addr}...`);
  faucet(addr, env('LND_FAUCET_AMOUNT', '2'), { confirm: true });
  await sleep(10000);

  const bal = parseInt(
    lncli('boltz-lnd', ['walletbalance']).json?.account_balance?.default?.confirmed_balance ?? '0',
    10,
  );
  if (bal < 1000000) fail(`boltz-lnd balance (${bal}) < 1,000,000 sats — funding failed`);
  log(`boltz-lnd balance: ${bal}`);

  await waitForOrFail('counterparty lnd', () => lncli('lnd', ['getinfo']).ok);
  const counterparty = lncli('lnd', ['getinfo']).json?.identity_pubkey;
  if (!counterparty) fail('Could not get counterparty lnd pubkey');
  log(`Opening channel to counterparty (${counterparty})...`);
  dockerExec('boltz-lnd', [
    ...lncliBase('boltz-lnd'), 'openchannel',
    '--node_key', counterparty,
    '--connect', 'lnd:9735',
    '--local_amt', env('LND_CHANNEL_SIZE', '1000000'),
    '--sat_per_vbyte', '1',
    '--min_confs', '0',
  ]);

  log('Mining 10 blocks to confirm channel...');
  mine(10);
  await sleep(10000);

  // Push some liquidity so the channel is balanced for reverse swaps.
  log('Balancing channel via a test invoice...');
  const invoice = lncli('lnd', ['addinvoice', '--amt', '500000']).json?.payment_request;
  if (invoice) dockerExec('boltz-lnd', [...lncliBase('boltz-lnd'), 'payinvoice', '--force', invoice]);
  log('LND channel setup completed');
}

async function fundBoltzCore() {
  // Boltz uses preferredWallet="core" → Bitcoin Core's default wallet. The old
  // bash iterated `listwallets` to find the funding wallet; our bitcoind only
  // ever has the single default ("") wallet, so we fund that directly.
  log('Funding Boltz Bitcoin Core wallet...');
  const addr = bitcoinCli(['getnewaddress'], { capture: true }).stdout;
  if (addr) {
    faucet(addr, 5, { confirm: true });
    log(`Boltz core wallet funded at ${addr}`);
  } else {
    warn('Could not get a Bitcoin Core address to fund Boltz');
  }
}

// Confirm the ARK pair is served both by Boltz directly AND through the nginx
// CORS proxy (the consumer-facing endpoint). Boltz must (re)connect to the
// ark/fulmine endpoint before it publishes the pair; on cold CI runners that
// handshake can take a couple of minutes.
async function verifyPairs() {
  const direct = env('BOLTZ_API_PORT', '9001');
  const proxy = env('NGINX_PORT', '9069');
  log('Verifying Boltz ARK/BTC pairs...');
  let lastDirect = '(none)';
  let lastProxy = '(none)';
  const has = async (port) => {
    const { text, status } = await fetchText(`http://localhost:${port}/v2/swap/submarine`, { timeoutMs: 15000 });
    return { ok: text.includes('"ARK"'), info: `HTTP ${status}: ${text.slice(0, 200)}` };
  };
  const ok = await waitFor(
    'Boltz ARK/BTC pairs',
    async () => {
      const d = await has(direct);
      lastDirect = d.info;
      if (!d.ok) return false;
      const p = await has(proxy);
      lastProxy = p.info;
      return p.ok;
    },
    { attempts: 90, intervalMs: 2000 },
  );
  if (!ok) {
    warn(`Boltz API (:${direct}) last response: ${lastDirect}`);
    warn(`nginx proxy (:${proxy}) last response: ${lastProxy}`);
    fail('Boltz ARK/BTC pairs not available');
  }
  log('Boltz ARK/BTC pairs available (direct API + nginx proxy)');
}

// Step run after the wallets exist: ensure the channel, restart boltz so it
// reconnects to a ready boltz-lnd, fund its core wallet, verify pairs.
export async function setupBoltz() {
  await setupLndChannel();

  log('Restarting Boltz to reconnect to boltz-lnd...');
  compose(['restart', 'boltz']);
  await sleep(5000);

  // Re-bind the nginx CORS proxy to the freshly-restarted boltz. nginx resolves
  // the `boltz` upstream once at startup (no resolver in cors.nginx.conf), so a
  // restart of boltz can leave it pointing at a stale/down upstream.
  log('Restarting Boltz CORS proxy to refresh its upstream...');
  compose(['restart', 'nginx-boltz']);
  await sleep(3000);

  await fundBoltzCore();
  await verifyPairs();
}
