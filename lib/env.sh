#!/usr/bin/env bash
# Shared environment loading logic for arkade-regtest scripts.
# Sources .env.defaults as base, then layers the first override found.

load_env() {
  local script_dir="$1"

  # Always load defaults as base
  source "$script_dir/.env.defaults"

  # Layer override: first found wins
  local override=""
  if [ -n "${USER_ENV:-}" ] && [ -f "$USER_ENV" ]; then
    override="$USER_ENV"
  elif [ -f "$script_dir/../.env.regtest" ]; then
    override="$script_dir/../.env.regtest"
  elif [ -f "$script_dir/.env" ]; then
    override="$script_dir/.env"
  fi

  if [ -n "$override" ]; then
    log "Loading overrides from $override"
    source "$override"
  fi

  # Derive the ark container name from mode.
  # Custom ARKD_IMAGE → "arkd"; nigiri built-in → "ark".
  # Can be overridden explicitly via env or .env file.
  if [ -z "${ARK_CONTAINER:-}" ]; then
    if [ -n "${ARKD_IMAGE:-}" ]; then
      ARK_CONTAINER="arkd"
    else
      ARK_CONTAINER="ark"
    fi
  fi
  export ARK_CONTAINER
}
