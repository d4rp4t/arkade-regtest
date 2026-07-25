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

mv "$BUILD_DIR/ERC20Swap_sol_ERC20Swap.bin" "$BUILD_DIR/ERC20Swap.bin"
mv "$BUILD_DIR/TestERC20_sol_TestERC20.bin" "$BUILD_DIR/TestERC20.bin"
mv "$BUILD_DIR/EtherSwap_sol_EtherSwap.bin" "$BUILD_DIR/EtherSwap.bin"

echo "Done. Bytecode written to $BUILD_DIR/{ERC20Swap,TestERC20,EtherSwap}.bin"
