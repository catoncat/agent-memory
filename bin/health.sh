#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tools/lib/mom-runtime-config.sh
source "$ROOT_DIR/tools/lib/mom-runtime-config.sh"
mom_config_load "$ROOT_DIR"

TODAY="$(date +%F)"
TODAY_FILE="$ROOT_DIR/10 Journal/Daily/$TODAY.md"

ENVCHAIN_NAMESPACE="${ENVCHAIN_NS:-${MOM_ENVCHAIN_NAMESPACE:-${MOM_CFG_RUNTIME_ENVCHAIN_NAMESPACE:-mom}}}"
ENVCHAIN_TIMEOUT_S="${MOM_ENVCHAIN_TIMEOUT_S:-${MOM_CFG_RUNTIME_ENVCHAIN_TIMEOUT_SECONDS:-20}}"
RECALL_SOURCE="${MOM_RECALL_SOURCE:-${MOM_CFG_MEMORY_RECALL_SOURCE:-log}}"
RECALL_LIMIT="${MOM_RECALL_LIMIT:-${MOM_CFG_MEMORY_RECALL_LIMIT:-1}}"

if ! [[ "$ENVCHAIN_TIMEOUT_S" =~ ^[0-9]+$ ]]; then
  ENVCHAIN_TIMEOUT_S=20
fi
if ! [[ "$RECALL_LIMIT" =~ ^[0-9]+$ ]]; then
  RECALL_LIMIT=1
fi

run_with_timeout() {
  local timeout_s="$1"
  shift

  "$@" &
  local cmd_pid=$!
  local elapsed=0

  while kill -0 "$cmd_pid" 2>/dev/null; do
    if (( elapsed >= timeout_s )); then
      kill "$cmd_pid" >/dev/null 2>&1 || true
      wait "$cmd_pid" >/dev/null 2>&1 || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  wait "$cmd_pid"
}

run_with_timeout_capture() {
  local timeout_s="$1"
  shift

  local tmp
  tmp="$(mktemp)"
  if run_with_timeout "$timeout_s" "$@" >"$tmp" 2>&1; then
    cat "$tmp"
    rm -f "$tmp"
    return 0
  fi

  local rc=$?
  cat "$tmp"
  rm -f "$tmp"
  return "$rc"
}

usage() {
  cat <<'USAGE'
用法:
  ./tools/mom-memory-health.sh [--query <搜索词>]

说明:
  检查记忆链路是否健康：日志写入 -> 向量库统计 -> recall 召回。
USAGE
}

QUERY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --query)
      QUERY="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$QUERY" && -f "$TODAY_FILE" ]]; then
  QUERY="$(
    rg '^-\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}[：:]' "$TODAY_FILE" \
      | tail -n1 \
      | sed -E 's/^- [0-9-]+ [0-9:]+[：:]\s*//' \
      | cut -c1-40 \
      || true
  )"
fi

QUERY="${QUERY:-反省记录}"
OK=1

echo "[health] memory 链路检查开始"
echo "[health] query=${QUERY}"
echo "[health] envchain_namespace=${ENVCHAIN_NAMESPACE}"
echo "[health] recall_source=${RECALL_SOURCE} recall_limit=${RECALL_LIMIT}"

echo "[check] 当日日志"
if [[ -f "$TODAY_FILE" ]] && rg -q '^-\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}[：:]' "$TODAY_FILE"; then
  echo "  PASS 10 Journal/Daily/$TODAY.md 存在且有流水"
else
  echo "  FAIL 10 Journal/Daily/$TODAY.md 不存在或无流水" >&2
  OK=0
fi

echo "[check] 向量库统计"
INDEX_OUTPUT=""
INDEX_MODE="bun"
if command -v envchain >/dev/null 2>&1; then
  echo "  INFO envchain 索引可能触发 Keychain 弹窗（手机远程看不到）"
  INDEX_MODE="envchain ${ENVCHAIN_NAMESPACE}"
  if INDEX_OUTPUT="$(run_with_timeout_capture "$ENVCHAIN_TIMEOUT_S" envchain "$ENVCHAIN_NAMESPACE" bun "$ROOT_DIR/tools/mom-memory-index.ts" --stats 2>&1)"; then
    :
  else
    local_rc=$?
    if [[ "$local_rc" -eq 124 ]]; then
      echo "  WARN envchain 索引超时(${ENVCHAIN_TIMEOUT_S}s)，回退 bun"
    fi
    INDEX_MODE="bun (fallback)"
    INDEX_OUTPUT="$(bun "$ROOT_DIR/tools/mom-memory-index.ts" --stats 2>&1 || true)"
  fi
else
  INDEX_OUTPUT="$(bun "$ROOT_DIR/tools/mom-memory-index.ts" --stats 2>&1 || true)"
fi

if [[ -z "${INDEX_OUTPUT//[[:space:]]/}" ]]; then
  INDEX_MODE="bun (fallback-empty)"
  INDEX_OUTPUT="$(bun "$ROOT_DIR/tools/mom-memory-index.ts" --stats 2>&1 || true)"
fi

if printf '%s\n' "$INDEX_OUTPUT" | rg -q '总记录:'; then
  local_total="$(
    printf '%s\n' "$INDEX_OUTPUT" \
      | rg --no-line-number '总记录:' \
      | head -n1 \
      | sed -E 's/^[0-9]+://; s/^[[:space:]]*//'
  )"
  echo "  PASS ${local_total}"
  echo "  MODE ${INDEX_MODE}"
else
  echo "  FAIL 向量库统计失败" >&2
  echo "  MODE ${INDEX_MODE}" >&2
  OK=0
fi

echo "[check] recall 召回"
RECALL_OUTPUT=""
RECALL_MODE="bun"
if command -v envchain >/dev/null 2>&1; then
  RECALL_MODE="envchain ${ENVCHAIN_NAMESPACE}"
  if RECALL_OUTPUT="$(run_with_timeout_capture "$ENVCHAIN_TIMEOUT_S" envchain "$ENVCHAIN_NAMESPACE" bun "$ROOT_DIR/tools/mom-recall.ts" "$QUERY" --source "$RECALL_SOURCE" --limit "$RECALL_LIMIT" 2>&1)"; then
    :
  else
    local_rc=$?
    if [[ "$local_rc" -eq 124 ]]; then
      echo "  WARN envchain recall 超时(${ENVCHAIN_TIMEOUT_S}s)，回退 bun"
    fi
    RECALL_MODE="bun (fallback)"
    RECALL_OUTPUT="$(bun "$ROOT_DIR/tools/mom-recall.ts" "$QUERY" --source "$RECALL_SOURCE" --limit "$RECALL_LIMIT" 2>&1 || true)"
  fi
else
  RECALL_OUTPUT="$(bun "$ROOT_DIR/tools/mom-recall.ts" "$QUERY" --source "$RECALL_SOURCE" --limit "$RECALL_LIMIT" 2>&1 || true)"
fi

if [[ -z "${RECALL_OUTPUT//[[:space:]]/}" ]]; then
  RECALL_MODE="bun (fallback-empty)"
  RECALL_OUTPUT="$(bun "$ROOT_DIR/tools/mom-recall.ts" "$QUERY" --source "$RECALL_SOURCE" --limit "$RECALL_LIMIT" 2>&1 || true)"
fi

if printf '%s\n' "$RECALL_OUTPUT" | rg --no-line-number -q '^1\.'; then
  first_hit="$(
    printf '%s\n' "$RECALL_OUTPUT" \
      | rg --no-line-number '^1\.' \
      | head -n1 \
      | sed -E 's/^[0-9]+://; s/^1\.\s*//; s/^[[:space:]]*//'
  )"
  echo "  PASS 命中: ${first_hit}"
  echo "  MODE ${RECALL_MODE}"
elif printf '%s\n' "$RECALL_OUTPUT" | rg -q '无结果'; then
  echo "  WARN recall 可执行但未命中"
  echo "  MODE ${RECALL_MODE}"
else
  first_line="$(printf '%s\n' "$RECALL_OUTPUT" | head -n1)"
  echo "  FAIL recall 执行异常: ${first_line}" >&2
  echo "  MODE ${RECALL_MODE}" >&2
  OK=0
fi

if [[ "$OK" -eq 1 ]]; then
  echo "[health] PASS memory 链路可用"
  exit 0
fi

echo "[health] FAIL memory 链路存在问题" >&2
exit 1
