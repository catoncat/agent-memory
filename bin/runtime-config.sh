#!/usr/bin/env bash

mom_is_true() {
  case "${1:-}" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On) return 0 ;;
    *) return 1 ;;
  esac
}

mom_config_load() {
  local root_dir="$1"
  if [[ -z "$root_dir" ]]; then
    return 0
  fi
  if ! command -v bun >/dev/null 2>&1; then
    return 0
  fi
  if [[ ! -f "$root_dir/tools/mom-config.ts" ]]; then
    return 0
  fi

  local shell_kv=""
  if shell_kv="$(bun "$root_dir/tools/mom-config.ts" shell 2>/dev/null)"; then
    # shellcheck disable=SC1090,SC2086
    eval "$shell_kv"
  fi
}
