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
import { log, fail } from '../log.mjs';
import { dockerExec } from '../proc.mjs';
import { ROOT } from '../compose.mjs';

const CONTRACTS_BUILD_DIR = join(ROOT, 'contracts', 'build');

// Anvil's well-known, publicly-documented deterministic account #0 (from its
// default dev mnemonic). Dev-only — never holds real funds, safe to hardcode.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const DEPLOYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const TBTC_SYMBOL = 'TBTC';
const TBTC_DECIMALS = 8;
// 1,000,000 TBTC at 8 decimals — plenty for regtest swaps.
const TBTC_INITIAL_SUPPLY = '100000000000000';

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
