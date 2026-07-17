#!/usr/bin/env bash
# case-cache.sh — Business case cache system for e2e-device
#
# Cache structure:
#   $E2E_HOME/projects/${PROJECT_HASH}/case-cache/${GIT_BRANCH}/${DOMAIN}.json
#
# Usage:
#   case-cache.sh check     <project_hash> <branch> <domain> [docs_path]
#   case-cache.sh save      <project_hash> <branch> <domain> <docs_path>
#   case-cache.sh load      <project_hash> <branch> <domain>
#   case-cache.sh invalidate <project_hash> <branch> <domain>
#   case-cache.sh clean     <project_hash>
set -euo pipefail

# ── Resolve E2E_HOME ──────────────────────────────────────────────────────────
E2E_HOME="${E2E_HOME:-$HOME/.e2e-device}"

# ── Platform detection ───────────────────────────────────────────────────────
_platform="$(uname -s)"

_md5() {
  # Compute MD5 of a file. Prints hex digest to stdout.
  local file="$1"
  if [[ "$_platform" == "Darwin" ]]; then
    md5 -q "$file"
  else
    md5sum "$file" | awk '{print $1}'
  fi
}

# ── Helpers ──────────────────────────────────────────────────────────────────

_cache_file_path() {
  local project_hash="$1"
  local branch="$2"
  local domain="$3"
  echo "$E2E_HOME/projects/${project_hash}/case-cache/${branch}/${domain}.json"
}

_ensure_jq() {
  if ! command -v jq &>/dev/null; then
    echo "[ERROR] jq is required but not installed. Install it with: brew install jq" >&2
    exit 2
  fi
}

# ── CLI dispatch ─────────────────────────────────────────────────────────────

cmd="${1:-}"
shift || true

case "$cmd" in
  check)
    project_hash="${1:-}"; branch="${2:-}"; domain="${3:-}"; docs_path="${4:-}"
    if [[ -z "$project_hash" || -z "$branch" || -z "$domain" ]]; then
      echo "Usage: case-cache.sh check <project_hash> <branch> <domain> [docs_path]" >&2
      exit 2
    fi

    cache_file=$(_cache_file_path "$project_hash" "$branch" "$domain")

    if [[ ! -f "$cache_file" ]]; then
      echo "[case-cache] cache miss: $cache_file not found" >&2
      exit 1
    fi

    _ensure_jq

    # Read all sourceFiles entries
    source_count=$(jq '.sourceFiles | length' "$cache_file" 2>/dev/null || echo 0)
    if [[ "$source_count" -eq 0 ]]; then
      echo "[case-cache] cache valid: no source files to verify" >&2
      exit 0
    fi

    # If docs_path is provided, resolve relative paths against it; otherwise use cwd
    base="${docs_path:-$PWD}"

    # Iterate over sourceFiles keys
    jq -r '.sourceFiles | keys[]' "$cache_file" 2>/dev/null | while IFS= read -r relpath; do
      stored_hash=$(jq -r --arg k "$relpath" '.sourceFiles[$k]' "$cache_file")
      full_path="$base/$relpath"

      if [[ ! -f "$full_path" ]]; then
        echo "[case-cache] stale: source file missing: $relpath" >&2
        exit 1
      fi

      current_hash=$(_md5 "$full_path")
      if [[ "$current_hash" != "$stored_hash" ]]; then
        echo "[case-cache] stale: $relpath hash changed (stored=$stored_hash current=$current_hash)" >&2
        exit 1
      fi
    done

    # If the while loop exited non-zero (due to a stale entry), exit 1
    # (set -o pipefail ensures we catch it)
    echo "[case-cache] cache valid: $source_count source files all match" >&2
    exit 0
    ;;

  save)
    project_hash="${1:-}"; branch="${2:-}"; domain="${3:-}"; docs_path="${4:-}"
    if [[ -z "$project_hash" || -z "$branch" || -z "$domain" || -z "$docs_path" ]]; then
      echo "Usage: case-cache.sh save <project_hash> <branch> <domain> <docs_path>" >&2
      exit 2
    fi

    _ensure_jq

    # Read cases JSON array from stdin, trim whitespace
    cases_json=$(cat | jq -c '.' 2>/dev/null)
    if [[ -z "$cases_json" || "$cases_json" == "null" ]]; then
      echo "[ERROR] stdin must be a valid JSON array of cases" >&2
      exit 1
    fi

    case_count=$(echo "$cases_json" | jq 'length')
    if [[ "$case_count" -eq 0 ]]; then
      echo "[ERROR] cases array is empty" >&2
      exit 1
    fi

    # Extract unique fromFile values and compute their hashes
    base="$docs_path"
    source_json="{}"
    source_count=0

    echo "$cases_json" | jq -r '.[].fromFile // empty' | sort -u | while IFS= read -r relpath; do
      [[ -z "$relpath" ]] && continue
      full_path="$base/$relpath"
      if [[ -f "$full_path" ]]; then
        h=$(_md5 "$full_path")
        # Accumulate JSON objects via a temp file (subshell-safe)
        echo "$relpath"$'\t'"$h" >> "$E2E_HOME/.case-cache-tmp-$$"
      fi
    done

    # Build sourceFiles JSON from the temp accumulator
    if [[ -f "$E2E_HOME/.case-cache-tmp-$$" ]]; then
      source_json="{"
      first=true
      while IFS=$'\t' read -r rp hh; do
        if $first; then first=false; else source_json+=", "; fi
        source_json+=$(printf '"%s": "%s"' "$rp" "$hh")
      done < "$E2E_HOME/.case-cache-tmp-$$"
      source_json+="}"
      source_count=$(wc -l < "$E2E_HOME/.case-cache-tmp-$$" | tr -d ' ')
      rm -f "$E2E_HOME/.case-cache-tmp-$$"
    fi

    cached_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%S")

    cache_file=$(_cache_file_path "$project_hash" "$branch" "$domain")
    mkdir -p "$(dirname "$cache_file")"

    # Write cache JSON using jq for reliable encoding
    generator_version="${E2E_GENERATOR_VERSION:-journey-v2-1}"
    jq -n \
      --arg domain "$domain" \
      --arg branch "$branch" \
      --arg cachedAt "$cached_at" \
      --arg generatorVersion "$generator_version" \
      --argjson sourceFiles "$source_json" \
      --argjson cases "$cases_json" \
      '{
        domain: $domain,
        branch: $branch,
        cachedAt: $cachedAt,
        generatorVersion: $generatorVersion,
        sourceFiles: $sourceFiles,
        cases: $cases
      }' > "$cache_file"

    echo "cached $case_count cases from $source_count source files"
    ;;

  load)
    project_hash="${1:-}"; branch="${2:-}"; domain="${3:-}"
    if [[ -z "$project_hash" || -z "$branch" || -z "$domain" ]]; then
      echo "Usage: case-cache.sh load <project_hash> <branch> <domain>" >&2
      exit 2
    fi

    _ensure_jq
    cache_file=$(_cache_file_path "$project_hash" "$branch" "$domain")

    if [[ ! -f "$cache_file" ]]; then
      echo "[case-cache] no cache at: $cache_file" >&2
      exit 1
    fi

    # Emit full cache object so TS can read generatorVersion
    jq -c '{ cases, generatorVersion, domain, branch, cachedAt, sourceFiles }' "$cache_file"
    exit 0
    ;;

  invalidate)
    project_hash="${1:-}"; branch="${2:-}"; domain="${3:-}"
    if [[ -z "$project_hash" || -z "$branch" || -z "$domain" ]]; then
      echo "Usage: case-cache.sh invalidate <project_hash> <branch> <domain>" >&2
      exit 2
    fi

    cache_file=$(_cache_file_path "$project_hash" "$branch" "$domain")
    if [[ -f "$cache_file" ]]; then
      rm -f "$cache_file"
      echo "[case-cache] invalidated: $cache_file"
    else
      echo "[case-cache] no cache to invalidate: $cache_file"
    fi
    ;;

  clean)
    project_hash="${1:-}"
    if [[ -z "$project_hash" ]]; then
      echo "Usage: case-cache.sh clean <project_hash>" >&2
      exit 2
    fi

    cache_dir="$E2E_HOME/projects/${project_hash}/case-cache"
    if [[ -d "$cache_dir" ]]; then
      rm -rf "$cache_dir"
      echo "[case-cache] cleaned all caches for project $project_hash"
    else
      echo "[case-cache] no caches for project $project_hash"
    fi
    ;;

  *)
    echo "Usage: case-cache.sh {check|save|load|invalidate|clean} ..." >&2
    echo "" >&2
    echo "Commands:" >&2
    echo "  check      <project_hash> <branch> <domain> [docs_path]   Verify cache validity" >&2
    echo "  save       <project_hash> <branch> <domain> <docs_path>   Save cases (read JSON array from stdin)" >&2
    echo "  load       <project_hash> <branch> <domain>               Output cached cases JSON to stdout" >&2
    echo "  invalidate <project_hash> <branch> <domain>               Delete cache for branch/domain" >&2
    echo "  clean      <project_hash>                                 Remove all caches for a project" >&2
    exit 2
    ;;
esac
