// EVM (Anvil) setup: deploys Boltz's ERC20Swap contract + a TestERC20 (used as
// the TBTC token) to the local Anvil node, then exposes the deployed addresses
// via process.env so docker-compose's ${VAR} interpolation can bake them into
// BOLTZ_CONFIG's [arbitrum] block before the boltz container starts — see
// regtest.mjs's start(), which calls setupEvm() before the boltz wave.
//
// Deployment runs `cast` *inside* the anvil container (dockerExec), not on the
// host — the anvil image already ships the full Foundry toolchain, so no host
// install of forge/cast is required, matching this repo's zero-host-dependency
// philosophy (compare bitcoinCli() in chain.mjs, which execs into the bitcoin
// container the same way).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log, fail, warn } from '../log.mjs';
import { docker, dockerExec } from '../proc.mjs';
import { ROOT } from '../compose.mjs';
import { waitFor } from '../wait.mjs';

const CONTRACTS_BUILD_DIR = join(ROOT, 'contracts', 'build');

// Anvil's well-known, publicly-documented deterministic account #0 (from its
// default dev mnemonic). Dev-only — never holds real funds, safe to hardcode.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const DEPLOYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const TBTC_SYMBOL = 'TBTC';
const TBTC_DECIMALS = 8;
// 1,000,000 TBTC at 8 decimals — plenty for regtest swaps.
const TBTC_INITIAL_SUPPLY = '100000000000000';

// Built into two env vars (ARBITRUM_CONFIG_TOML, ARK_TBTC_PAIR_TOML) that
// docker/compose.ark.yml's BOLTZ_CONFIG substitutes in as ${VAR:-} — empty
// string when unset, i.e. whenever the evm profile didn't run. This is what
// keeps `--profile boltz` (no evm) fully independent of EVM/Anvil: Boltz gets
// no [arbitrum] block and no ARK<->TBTC pair, exactly like before Milestone 3,
// and nothing EVM-related can affect its Lightning/BTC/ARK pairs.
function buildArbitrumConfigToml({ etherSwapAddress, erc20SwapAddress, tbtcAddress }) {
  return `# EVM (Arbitrum) chain config, pointed at the local Anvil node. Contract
# addresses come from lib/setup/evm.mjs, which deploys EtherSwap +
# ERC20Swap + a TestERC20 (as TBTC) to Anvil and builds this block before
# the boltz container starts — see regtest.mjs's start(), which runs
# setupEvm() ahead of the boltz wave specifically so these addresses are
# baked in correctly. EtherSwap is deployed but otherwise unused (no
# native-ETH HTLC swaps in this setup) — Boltz's EthereumConfig requires a
# real contract at etherSwap and refuses to start ("no contract at
# address") against a placeholder/zero address.
[arbitrum]
providerEndpoint = "http://anvil:8545"
# Required against Anvil: ArbitrumProvider.getLatestBlock() (lib/wallet/
# ethereum/ArbitrumProvider.ts) reads eth_getBlockByNumber's l1BlockNumber
# field and, without regtest=true, throws at startup ("Arbitrum RPC
# returned no l1BlockNumber...") instead of falling back to the plain L2
# block number — Anvil doesn't populate that field.
regtest = true

# Required, not optional, despite not being documented in docs/boltz.conf's
# commented-out Arbitrum example: ArbitrumConfig.l1Providers (dist/lib/
# Config.d.ts in the boltz/boltz:latest image) is a required field, not an
# optional one. ArbitrumProvider's constructor (dist/lib/wallet/ethereum/
# ArbitrumProvider.js) builds a second, nested InjectedProvider for the L1
# (Ethereum) side — since Arbitrum is an L2 — using
# { providers: config.l1Providers }; that nested InjectedProvider's
# constructor throws NO_PROVIDER_SPECIFIED synchronously if l1Providers is
# undefined, which is exactly what was causing "Disabled Arbitrum
# integration because: no RPC provider was specified" (the failure was a
# pure config check, not a real connection attempt — hence firing within
# ~1ms of the previous log line). No real L1 node exists in this regtest
# stack; pointing it at the same Anvil instance just satisfies the
# constructor. l1Provider is only actually queried via getLocktimeHeight()
# for HTLC timelock checks — revisit if that turns out to matter
# functionally for the ARK<->TBTC swap path.
[[arbitrum.l1Providers]]
endpoint = "http://anvil:8545"

[[arbitrum.contracts]]
etherSwap = "${etherSwapAddress}"
erc20Swap = "${erc20SwapAddress}"

[[arbitrum.tokens]]
symbol = "TBTC"
contractAddress = "${tbtcAddress}"
decimals = 8
minWalletBalance = 100000000`;
}

function buildArkTbtcPairToml() {
  return `[[pairs]]
base = "ARK"
quote = "TBTC"
rate = 1
fee = 0.4
swapInFee = 0.01
invoiceExpiry = 3600
maxSwapAmount = 4294967
minSwapAmount = 1000

[pairs.timeoutDelta]
## Same rationale as the ARK/BTC pair above.
reverse = 240
chain = 100
swapMinimal = 100
swapMaximal = 200
swapTaproot = 1200`;
}

// --rpc-url must precede --create/positional args — cast stops parsing flags
// once it sees the first positional argument (e.g. the bytecode/address).
function cast([subcommand, ...rest]) {
  return dockerExec(
    'anvil',
    ['cast', subcommand, '--rpc-url', 'http://localhost:8545', ...rest],
    { capture: true },
  );
}

function deployRaw(binFile, label, ctorSig, ctorArgs = []) {
  const bytecode = readFileSync(join(CONTRACTS_BUILD_DIR, binFile), 'utf8').trim();
  const args = ['send', '--private-key', DEPLOYER_KEY, '--create', `0x${bytecode}`];
  if (ctorSig) args.push(ctorSig, ...ctorArgs);
  args.push('--json');

  const res = cast(args);
  if (res.code !== 0) fail(`Failed to deploy ${label}: ${res.stderr || res.stdout}`);

  let receipt;
  try {
    receipt = JSON.parse(res.stdout);
  } catch {
    fail(`Failed to parse deploy receipt for ${label}: ${res.stdout}`);
  }
  if (receipt.status !== '0x1') fail(`Deployment of ${label} reverted (tx ${receipt.transactionHash})`);

  return receipt.contractAddress;
}

/**
 * Deploys EtherSwap + ERC20Swap + TestERC20(TBTC) to Anvil and stashes their
 * addresses in process.env for the compose-file interpolation that follows.
 * Returns the addresses too, for direct use (e.g. funding transfers). This
 * regtest setup only exercises ERC20Swap/TBTC swaps, but EtherSwap is
 * deployed anyway — Boltz's EthereumConfig requires a valid etherSwap
 * contract address and refuses to start ("no contract at address") if it
 * doesn't have real bytecode behind it, even when unused.
 */
export async function setupEvm() {
  log('Deploying EtherSwap + ERC20Swap + TestERC20 (TBTC) to Anvil...');

  const etherSwapAddress = deployRaw('EtherSwap.bin', 'EtherSwap');
  log(`  EtherSwap deployed at ${etherSwapAddress}`);

  const erc20SwapAddress = deployRaw('ERC20Swap.bin', 'ERC20Swap');
  log(`  ERC20Swap deployed at ${erc20SwapAddress}`);

  const tbtcAddress = deployRaw(
    'TestERC20.bin',
    'TestERC20 (TBTC)',
    'constructor(string,string,uint8,uint256)',
    ['Test Bitcoin', TBTC_SYMBOL, String(TBTC_DECIMALS), TBTC_INITIAL_SUPPLY],
  );
  log(`  TBTC (TestERC20) deployed at ${tbtcAddress}`);

  process.env.EVM_ETHERSWAP_ADDRESS = etherSwapAddress;
  process.env.EVM_ERC20SWAP_ADDRESS = erc20SwapAddress;
  process.env.EVM_TBTC_ADDRESS = tbtcAddress;

  // Only set when setupEvm() actually ran (i.e. the evm profile is active) —
  // BOLTZ_CONFIG's ${ARBITRUM_CONFIG_TOML:-}/${ARK_TBTC_PAIR_TOML:-} fall back
  // to empty strings otherwise, so plain `--profile boltz` stays EVM-free.
  process.env.ARBITRUM_CONFIG_TOML = buildArbitrumConfigToml({ etherSwapAddress, erc20SwapAddress, tbtcAddress });
  process.env.ARK_TBTC_PAIR_TOML = buildArkTbtcPairToml();

  return { etherSwapAddress, erc20SwapAddress, tbtcAddress };
}

/**
 * Funds `address` from Anvil's pre-funded deployer account: native ETH (gas)
 * plus `tbtcAmount` (in TBTC's base units, i.e. already scaled by 1e8) of the
 * deployed TestERC20. Used to fund Boltz's own derived EVM wallet once it's
 * known (Boltz has no mnemonic/address config field — it derives its EVM
 * address from its own wallet on first boot, so this can only run after
 * Boltz has started at least once — see README/regtest.mjs for the discovery
 * step).
 */
export function fundEvmAddress(address, tbtcAmount = '100000000000') {
  log(`Funding ${address}: 10 ETH (gas) + ${tbtcAmount} TBTC base units...`);

  const ethRes = cast(['send', '--private-key', DEPLOYER_KEY, address, '--value', '10ether']);
  if (ethRes.code !== 0) fail(`Failed to fund ${address} with ETH: ${ethRes.stderr || ethRes.stdout}`);

  const tbtcAddress = process.env.EVM_TBTC_ADDRESS;
  if (!tbtcAddress) fail('fundEvmAddress: EVM_TBTC_ADDRESS not set — call setupEvm() first');

  const tokenRes = cast([
    'send', '--private-key', DEPLOYER_KEY, tbtcAddress,
    'transfer(address,uint256)', address, tbtcAmount,
  ]);
  if (tokenRes.code !== 0) fail(`Failed to fund ${address} with TBTC: ${tokenRes.stderr || tokenRes.stdout}`);

  log(`  Funded ${address}`);
}

// Boltz logs its derived Arbitrum wallet address at startup — there's no config
// field for it (no mnemonic/address in EthereumConfig; boltzd derives its own
// wallet from its master seed on first boot, matching `derivationPath` if set).
const BOLTZ_EVM_ADDRESS_PATTERN = /Starting Arbitrum transaction tracker for address: (0x[0-9a-fA-F]{40})/;

/**
 * Polls `docker logs boltz` for boltzd's self-reported Arbitrum wallet address
 * and funds it via fundEvmAddress(). Boltz's first startup attempt is expected
 * to crash-loop until this runs (it can't estimate gas for its ERC20Swap
 * allowance approval from a zero-balance wallet) — regtest.mjs calls this
 * right after boltz's first bring-up, before setupBoltz()'s restart+verify
 * cycle, so by the time that runs boltz has funds and stops crash-looping.
 */
export async function fundBoltzEvmWalletFromLogs() {
  let address;

  const found = await waitFor(
    "boltz's Arbitrum wallet address (in its logs)",
    () => {
      const { stdout } = docker(['logs', 'boltz'], { capture: true });
      const match = stdout.match(BOLTZ_EVM_ADDRESS_PATTERN);
      if (match) {
        address = match[1];
        return true;
      }
      return false;
    },
    // Boltz can take a couple of minutes to reach Arbitrum init on a cold CI
    // runner (image pull, DB migrations, LND connections all happen first) —
    // matches setupBoltz()'s verifyPairs(), which allows the same 90x2s=180s
    // for exactly the same reason. 30x2s=60s was enough locally but not in CI.
    { attempts: 90, intervalMs: 2000 },
  );

  if (!found) {
    warn("Could not find boltz's Arbitrum wallet address in its logs — skipping EVM wallet funding; boltz will keep crash-looping on the ERC20Swap allowance approval");
    return;
  }

  log(`Discovered boltz's Arbitrum wallet address: ${address}`);
  fundEvmAddress(address);
}
