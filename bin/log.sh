#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=tools/lib/mom-runtime-config.sh
source "$ROOT_DIR/tools/lib/mom-runtime-config.sh"
mom_config_load "$ROOT_DIR"

TODAY="$(date +%F)"
NOW="$(date '+%Y-%m-%d %H:%M')"
TODAY_FILE="$ROOT_DIR/10 Journal/Daily/$TODAY.md"

ENVCHAIN_NAMESPACE="${ENVCHAIN_NS:-${MOM_ENVCHAIN_NAMESPACE:-${MOM_CFG_RUNTIME_ENVCHAIN_NAMESPACE:-mom}}}"
ENVCHAIN_TIMEOUT_S="${MOM_ENVCHAIN_TIMEOUT_S:-${MOM_CFG_RUNTIME_ENVCHAIN_TIMEOUT_SECONDS:-20}}"
NOTE_AUTO_PUBLISH="${MOM_NOTE_AUTO_PUBLISH:-${MOM_CFG_MEMORY_NOTES_AUTO_PUBLISH:-true}}"
NOTE_SAVE_TO_OBSIDIAN="${MOM_NOTE_SAVE_TO_OBSIDIAN:-${MOM_CFG_MEMORY_NOTES_SAVE_TO_OBSIDIAN:-true}}"
NOTE_MAX_LENGTH="${MOM_NOTE_MAX_LENGTH:-${MOM_CFG_MEMORY_NOTES_MAX_LENGTH:-260}}"

if ! [[ "$ENVCHAIN_TIMEOUT_S" =~ ^[0-9]+$ ]]; then
  ENVCHAIN_TIMEOUT_S=20
fi
if ! [[ "$NOTE_MAX_LENGTH" =~ ^[0-9]+$ ]] || [[ "$NOTE_MAX_LENGTH" -lt 20 ]]; then
  NOTE_MAX_LENGTH=260
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

print_usage() {
  cat <<'USAGE'
用法:
  ./tools/mom-memory-log.sh "一句话摘要" [细节1] [细节2] ...
  ./tools/mom-memory-log.sh --reflect \
    --scenario <场景> \
    --review <复盘一句话> \
    [--change <改变提案>] \
    [--next-action <下一步动作>] \
    [--metric <观测指标>] \
    [--input <输入>] [--skill-chain <技能链>] [--strategy <策略>] \
    [--fallback-count <次数>] [--latency-ms <毫秒>] \
    [--result <success|failed|partial>] [--self-score <1-5>] [--title <标题>]

示例:
  ./tools/mom-memory-log.sh "修复 Cloudflare Tunnel 断连" "重启 launchd 生效" "验证 mt.138000.xyz 返回 200"
  ./tools/mom-memory-log.sh --reflect --scenario chat-url-summary --input "https://x.com/..." --skill-chain "sum-url -> link-capture-workflow" --strategy "jina" --fallback-count 1 --latency-ms 2480 --result success --self-score 4 --review "遇到 403 后回退成功，下次优先直接走 jina"
  ./tools/mom-memory-log.sh --reflect --scenario chat-url-summary --result failed --review "X 链接被风控拦截，摘要失败" --change "X 站默认先走 jina" --next-action "补一个 browser-session 回退链路" --metric "下周 X 链接失败率<30%"
USAGE
}

ensure_today_file() {
  mkdir -p "$ROOT_DIR/10 Journal/Daily"
  if [[ ! -f "$TODAY_FILE" ]]; then
    cat >"$TODAY_FILE" <<TPL
---
slug: "$TODAY"
---
# $TODAY

## 当日流水
TPL
  fi

  if ! rg -q '^## 当日流水$' "$TODAY_FILE"; then
    cat >>"$TODAY_FILE" <<'TPL'

## 当日流水
TPL
  fi
}

append_legacy_entry() {
  local title="$1"
  shift || true
  {
    echo
    echo "- ${NOW}：${title}"
    for detail in "$@"; do
      [[ -n "${detail}" ]] && echo "  - ${detail}"
    done
  } >>"$TODAY_FILE"
}

append_reflect_entry() {
  local scenario="$1"
  local input_ref="$2"
  local skill_chain="$3"
  local strategy="$4"
  local fallback_count="$5"
  local latency_ms="$6"
  local result="$7"
  local self_score="$8"
  local review="$9"
  local change="${10}"
  local next_action="${11}"
  local metric="${12}"
  local title="${13}"

  local headline="${title:-反省记录（${scenario}）}"
  {
    echo
    echo "- ${NOW}：${headline}"
    echo "  - 场景: ${scenario}"
    [[ -n "$input_ref" ]] && echo "  - 输入: ${input_ref}"
    [[ -n "$skill_chain" ]] && echo "  - 技能链: ${skill_chain}"
    [[ -n "$strategy" ]] && echo "  - 策略: ${strategy}"
    echo "  - 回退次数: ${fallback_count}"
    [[ -n "$latency_ms" ]] && echo "  - 耗时_ms: ${latency_ms}"
    echo "  - 结果: ${result}"
    [[ -n "$self_score" ]] && echo "  - 自评分: ${self_score}"
    echo "  - 复盘: ${review}"
    [[ -n "$change" ]] && echo "  - 改变提案: ${change}"
    [[ -n "$next_action" ]] && echo "  - 下一步: ${next_action}"
    [[ -n "$metric" ]] && echo "  - 观测指标: ${metric}"
    true
  } >>"$TODAY_FILE"
}

trigger_index() {
  cd "$ROOT_DIR"
  mkdir -p tools/data
  local index_log="tools/data/memory-index.last.log"
  local index_cmd=(bun tools/mom-memory-index.ts --file "$TODAY_FILE")
  local indexed=0

  if command -v envchain >/dev/null 2>&1; then
    echo "[envchain] 记忆索引将尝试读取 Keychain（可能弹本机密码框，手机远程看不到）" >&2
    echo "[envchain] namespace=${ENVCHAIN_NAMESPACE}，若无响应请在 Mac 本机执行: envchain ${ENVCHAIN_NAMESPACE} true" >&2
    if run_with_timeout "$ENVCHAIN_TIMEOUT_S" envchain "$ENVCHAIN_NAMESPACE" "${index_cmd[@]}" >"$index_log" 2>&1; then
      indexed=1
    else
      local rc=$?
      if [[ "$rc" -eq 124 ]]; then
        echo "[envchain] 记忆索引等待 Keychain 超时(${ENVCHAIN_TIMEOUT_S}s)，改走 bun 回退" >&2
      fi
    fi
  fi

  if [[ "$indexed" -eq 0 ]]; then
    if "${index_cmd[@]}" >"$index_log" 2>&1; then
      indexed=1
    fi
  fi

  if [[ "$indexed" -eq 1 ]]; then
    echo "向量索引完成: $index_log"
  else
    echo "向量索引失败（详见日志）: $index_log" >&2
  fi
}

is_sensitive_note() {
  local text="$1"
  printf '%s\n' "$text" | rg -qi '([0-9]{1,3}\.){3}[0-9]{1,3}|(password|passwd|token|secret|api[_ -]?key|authorization|bearer|私钥|密钥|密码|ssh-rsa|BEGIN [A-Z ]*PRIVATE KEY)'
}

trigger_note_publish() {
  local headline="$1"
  local review="${2:-}"

  if mom_is_true "${MOM_SKIP_NOTE_DRAFT:-0}" || mom_is_true "${MOM_SKIP_NOTE_PUBLISH:-0}"; then
    return 0
  fi

  local draft=""
  if [[ -n "$review" ]]; then
    draft="${headline}：${review}"
  else
    draft="${headline}"
  fi

  draft="$(printf '%s' "$draft" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+|[[:space:]]+$//g')"
  if (( ${#draft} > NOTE_MAX_LENGTH )); then
    local keep_len=$((NOTE_MAX_LENGTH - 1))
    if (( keep_len < 1 )); then keep_len=1; fi
    draft="${draft:0:keep_len}…"
  fi

  local quoted
  quoted="$(printf '%q' "$draft")"

  if ! mom_is_true "$NOTE_AUTO_PUBLISH"; then
    echo "[mom-note] autoPublish=false, draft: ${draft}"
    if mom_is_true "$NOTE_SAVE_TO_OBSIDIAN"; then
      echo "[mom-note] manual publish: bun tools/mom-note.ts ${quoted} --save"
    else
      echo "[mom-note] manual publish: bun tools/mom-note.ts ${quoted}"
    fi
    return 0
  fi

  if is_sensitive_note "$draft"; then
    echo "[mom-note] 检测到敏感信息，跳过自动发布" >&2
    echo "[mom-note] draft: ${draft}" >&2
    if mom_is_true "$NOTE_SAVE_TO_OBSIDIAN"; then
      echo "[mom-note] retry(after sanitize): bun tools/mom-note.ts ${quoted} --save" >&2
    else
      echo "[mom-note] retry(after sanitize): bun tools/mom-note.ts ${quoted}" >&2
    fi
    return 0
  fi

  local cmd=(bun "$ROOT_DIR/tools/mom-note.ts" "$draft")
  if mom_is_true "$NOTE_SAVE_TO_OBSIDIAN"; then
    cmd+=(--save)
  fi

  local out
  if out="$("${cmd[@]}" 2>&1)"; then
    local url
    url="$(printf '%s\n' "$out" | rg -o 'https://s\.chen\.rs/[A-Za-z0-9._-]+' | head -n1 || true)"
    if [[ -n "$url" ]]; then
      echo "[mom-note] auto published: $url"
    else
      echo "[mom-note] auto published"
    fi
  else
    echo "[mom-note] 自动发布失败，保留草稿" >&2
    echo "[mom-note] draft: ${draft}" >&2
    if mom_is_true "$NOTE_SAVE_TO_OBSIDIAN"; then
      echo "[mom-note] retry: bun tools/mom-note.ts ${quoted} --save" >&2
    else
      echo "[mom-note] retry: bun tools/mom-note.ts ${quoted}" >&2
    fi
    echo "$out" >&2
  fi
}

if [[ $# -eq 0 ]]; then
  print_usage
  exit 1
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_usage
  exit 0
fi

if [[ "${1:-}" == "--reflect" ]]; then
  shift

  SCENARIO=""
  INPUT_REF=""
  SKILL_CHAIN=""
  STRATEGY=""
  FALLBACK_COUNT="0"
  LATENCY_MS=""
  RESULT="success"
  SELF_SCORE=""
  REVIEW=""
  CHANGE=""
  NEXT_ACTION=""
  METRIC=""
  TITLE=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scenario)
        SCENARIO="${2:-}"
        shift 2
        ;;
      --input)
        INPUT_REF="${2:-}"
        shift 2
        ;;
      --skill-chain)
        SKILL_CHAIN="${2:-}"
        shift 2
        ;;
      --strategy)
        STRATEGY="${2:-}"
        shift 2
        ;;
      --fallback-count)
        FALLBACK_COUNT="${2:-}"
        shift 2
        ;;
      --latency-ms)
        LATENCY_MS="${2:-}"
        shift 2
        ;;
      --result)
        RESULT="${2:-}"
        shift 2
        ;;
      --self-score)
        SELF_SCORE="${2:-}"
        shift 2
        ;;
      --review)
        REVIEW="${2:-}"
        shift 2
        ;;
      --change)
        CHANGE="${2:-}"
        shift 2
        ;;
      --next-action)
        NEXT_ACTION="${2:-}"
        shift 2
        ;;
      --metric)
        METRIC="${2:-}"
        shift 2
        ;;
      --title)
        TITLE="${2:-}"
        shift 2
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      *)
        echo "未知参数: $1" >&2
        print_usage
        exit 1
        ;;
    esac
  done

  if [[ -z "$SCENARIO" ]]; then
    echo "缺少 --scenario" >&2
    exit 1
  fi
  if [[ -z "$REVIEW" ]]; then
    echo "缺少 --review" >&2
    exit 1
  fi
  if ! [[ "$FALLBACK_COUNT" =~ ^[0-9]+$ ]]; then
    echo "--fallback-count 必须是非负整数" >&2
    exit 1
  fi
  if [[ -n "$LATENCY_MS" ]] && ! [[ "$LATENCY_MS" =~ ^[0-9]+$ ]]; then
    echo "--latency-ms 必须是非负整数" >&2
    exit 1
  fi
  if [[ -n "$SELF_SCORE" ]] && ! [[ "$SELF_SCORE" =~ ^[1-5]$ ]]; then
    echo "--self-score 必须是 1-5" >&2
    exit 1
  fi
  case "$RESULT" in
    success|failed|partial) ;;
    *)
      echo "--result 仅支持 success|failed|partial" >&2
      exit 1
      ;;
  esac
  if [[ "$RESULT" == "failed" ]]; then
    if [[ -z "$CHANGE" ]]; then
      echo "结果为 failed 时缺少 --change（必须提出改变）" >&2
      exit 1
    fi
    if [[ -z "$NEXT_ACTION" ]]; then
      echo "结果为 failed 时缺少 --next-action（必须给出下一步）" >&2
      exit 1
    fi
    if [[ -z "$METRIC" ]]; then
      echo "结果为 failed 时缺少 --metric（必须给出观测指标）" >&2
      exit 1
    fi
  fi

  ensure_today_file
  append_reflect_entry \
    "$SCENARIO" \
    "$INPUT_REF" \
    "$SKILL_CHAIN" \
    "$STRATEGY" \
    "$FALLBACK_COUNT" \
    "$LATENCY_MS" \
    "$RESULT" \
    "$SELF_SCORE" \
    "$REVIEW" \
    "$CHANGE" \
    "$NEXT_ACTION" \
    "$METRIC" \
    "$TITLE"

  echo "已写入记忆: 10 Journal/Daily/$TODAY.md"
  trigger_index
  trigger_note_publish "${TITLE:-反省记录（${SCENARIO}）}" "$REVIEW"
  exit 0
fi

TITLE="${1:-}"
shift || true
if [[ -z "$TITLE" ]]; then
  print_usage
  exit 1
fi

ensure_today_file
append_legacy_entry "$TITLE" "$@"

echo "已写入记忆: 10 Journal/Daily/$TODAY.md"
trigger_index
trigger_note_publish "$TITLE" "${1:-}"
