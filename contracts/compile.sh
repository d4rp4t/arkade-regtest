#!/usr/bin/env bash
# Compiles the vendored contracts (contracts/sol/) into contracts/build/*.bin —
# plain hex bytecode consumed by lib/setup/evm.mjs at regtest startup via
# `cast send --create`. Run this whenever contracts/sol/ changes; the build
# output is committed so regtest.mjs doesn't need solc at runtime, only cast
# (which ships inside the anvil container's Foundry image — see lib/setup/evm.mjs).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOL_DIR="$HERE/sol"
BUILD_DIR="$HERE/build"
SOLC_VERSION="0.8.33"

mkdir -p "$BUILD_DIR"

compile() {
  local contract_file="$1" contract_name="$2"
  local out_dir
  out_dir="$(mktemp -d)"
  echo "Compiling $contract_file with solc@$SOLC_VERSION..."
  (cd "$SOL_DIR" && npx --yes "solc@$SOLC_VERSION" --bin -o "$out_dir" "$contract_file")
  cp "$out_dir/${contract_name}.bin" "$BUILD_DIR/${contract_name}.bin"
  rm -rf "$out_dir"
}

compile "ERC20Swap.sol" "ERC20Swap_sol_ERC20Swap"
compile "TestERC20.sol" "TestERC20_sol_TestERC20"
# Boltz's EthereumConfig requires a deployed etherSwap contract address (it
# validates bytecode exists there at startup) even though this regtest setup
# only exercises ERC20Swap/TBTC — so it's deployed too, just unused.
compile "EtherSwap.sol" "EtherSwap_sol_EtherSwap"
# Router + its DEX-hop test double, for Milestone 4's USDT/generic-ERC20 support (see
# lib/setup/evm.mjs's setupUsdtDexHop()). Boltz itself never learns about either — the DEX hop
# is entirely client-side. Real Permit2 is deployed from vendored runtime bytecode instead of
# compiled (see permit2/test/utils/DeployPermit2.sol, read directly by evm.mjs — that file
# imports forge-std/Script.sol, which isn't vendored here, so it's deliberately excluded from
# this compile step).
compile "Router.sol" "Router_sol_Router"
compile "test-fixtures/MockErc20Dex.sol" "test-fixtures_MockErc20Dex_sol_MockERC20Dex"

mv "$BUILD_DIR/ERC20Swap_sol_ERC20Swap.bin" "$BUILD_DIR/ERC20Swap.bin"
mv "$BUILD_DIR/TestERC20_sol_TestERC20.bin" "$BUILD_DIR/TestERC20.bin"
mv "$BUILD_DIR/EtherSwap_sol_EtherSwap.bin" "$BUILD_DIR/EtherSwap.bin"
mv "$BUILD_DIR/Router_sol_Router.bin" "$BUILD_DIR/Router.bin"
mv "$BUILD_DIR/test-fixtures_MockErc20Dex_sol_MockERC20Dex.bin" "$BUILD_DIR/MockErc20Dex.bin"

echo "Done. Bytecode written to $BUILD_DIR/{ERC20Swap,TestERC20,EtherSwap,Router,MockErc20Dex}.bin"
