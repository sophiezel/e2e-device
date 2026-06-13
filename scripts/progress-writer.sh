#!/usr/bin/env bash
# Write a progress event as a JSONL line to a progress file.
#
# Usage:
#   bash progress-writer.sh <progress_file> <seq> <caseId> <status> <desc> [duration_ms] [llm_interventions_json]
#
# Example:
#   bash progress-writer.sh ./test-progress.jsonl 1 infra-001 running "打开估价页"
#   bash progress-writer.sh ./test-progress.jsonl 2 biz-005 passed "提交估价" 1234 '[{"tool":"edit","summary":"fix selector"}]'
set -euo pipefail

PROGRESS_FILE="$1"
SEQ="$2"
CASE_ID="$3"
STATUS="$4"
DESC="$5"
DURATION_MS="${6:-}"
LLM_INTERVENTIONS="${7:-}"

# Validate status enum
case "$STATUS" in
  running|passed|failed|timeout|skipped|skipped_auth) ;;
  *)
    echo "[progress-writer] invalid status: $STATUS (must be one of: running, passed, failed, timeout, skipped, skipped_auth)" >&2
    exit 1
    ;;
esac

# Build JSON line
TS=$(date +%s)

# Escape special JSON characters in desc
DESC_ESCAPED=$(printf '%s' "$DESC" | sed 's/\\/\\\\/g; s/"/\\"/g')

JSON_LINE="{\"ts\":${TS},\"seq\":${SEQ},\"caseId\":\"${CASE_ID}\",\"status\":\"${STATUS}\",\"desc\":\"${DESC_ESCAPED}\""

if [[ -n "$DURATION_MS" ]]; then
  JSON_LINE="${JSON_LINE},\"duration_ms\":${DURATION_MS}"
fi

if [[ -n "$LLM_INTERVENTIONS" ]]; then
  JSON_LINE="${JSON_LINE},\"llm_interventions\":${LLM_INTERVENTIONS}"
fi

JSON_LINE="${JSON_LINE}}"

echo "$JSON_LINE" >> "$PROGRESS_FILE"
