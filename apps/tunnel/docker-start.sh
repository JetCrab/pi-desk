#!/bin/bash
set -euo pipefail
umask 077

fail() {
  printf '隧道启动失败：%s\n' "$1" >&2
  exit 1
}

persist_key() {
  local path="$1" supplied="$2" key
  if [[ -n "$supplied" ]]; then
    key="$supplied"
  elif [[ -f "$path" ]]; then
    key=$(<"$path")
  else
    key=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  fi
  [[ "$key" =~ ^[0-9a-fA-F]{64}$ ]] || fail "密钥必须为 64 位十六进制，检查传入值或 $path"
  printf '%s\n' "$key" > "$path.tmp" || fail "无法写入密钥到 $path.tmp"
  mv -fT -- "$path.tmp" "$path" || fail "无法保存密钥到 $path"
  printf '%s' "$key"
}

data_dir="${PI_DESK_TUNNEL_DATA_DIR:-/data}"
mkdir -p "$data_dir"
export PI_DESK_TUNNEL_SERVER_KEY
PI_DESK_TUNNEL_SERVER_KEY=$(persist_key "$data_dir/server-key" "${PI_DESK_TUNNEL_SERVER_KEY:-}")
export PI_DESK_TUNNEL_IROH_RELAY_TOKEN
PI_DESK_TUNNEL_IROH_RELAY_TOKEN=$(persist_key "$data_dir/relay-token" '')
exec pi-desk-tunnel-server
