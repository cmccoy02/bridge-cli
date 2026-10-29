#!/usr/bin/env bash
# Daily / interval Bridge runner.
#
# Fetches or clones a target repo, runs `bridge patch` with the repo's own
# after-script suite, and copies the compact run summary to a dated folder.
# Overlapping invocations refuse to start (lockfile). Exit status is non-zero
# when setup fails, a lock is held, or Bridge itself fails. Pull requests are
# created only when the normal Bridge gates pass — this wrapper does not
# bypass them.
#
# Usage:
#   scripts/bridge-daily.sh --repo <git-url-or-local-path> [options]
#
# Options:
#   --repo <url|path>     Required. Git URL to clone, or an existing checkout.
#   --branch <name>       Default branch to check out (default: origin/HEAD).
#   --workdir <dir>       Dedicated clone directory (default:
#                         $BRIDGE_HOME/schedule/repos/<name>). Local checkouts
#                         always run here — never in the developer's tree.
#   --summary-dir <dir>   Dated summary destination (default:
#                         $BRIDGE_HOME/schedule/summaries/<name>).
#   --config <path>       Copy this Bridge config into the isolated workdir
#                         before running. Highest priority every run. Without
#                         --config, the developer's current checkout config
#                         is re-copied; then $BRIDGE_HOME/schedule/configs.
#                         A leftover copy from an earlier run is never reused
#                         ahead of those sources. Required for a fresh URL
#                         clone unless a config is already committed or
#                         present at
#                         $BRIDGE_HOME/schedule/configs/<name>/bridge.config.json.
#   --bridge <cmd>        Bridge executable (default: bridge on PATH, else
#                         this repo's bin/bridge.js).
#   --skip-before-scripts Pass --skip-before-scripts to Bridge (default: on).
#   --run-before-scripts  Do not pass --skip-before-scripts.
#   --dry-run             Pass --dry-run to Bridge (no commit/push/PR).
#   --notify              After the run, fire the local notification hook
#                         (BRIDGE_NOTIFY_COMMAND, or osascript on macOS).
#                         Skipped inside `bridge schedule run`, which notifies once.
#   --                    Extra arguments forwarded to `bridge patch`.
#
# Environment:
#   BRIDGE_HOME           Artifact root (default: ~/.bridge).
#   BRIDGE_BIN            Override for --bridge.
#   BRIDGE_DAILY_REPO     Override for --repo.
#   BRIDGE_DAILY_CONFIG   Override for --config.
#
# Exit codes:
#   0  Bridge succeeded
#   1  Bridge or repo setup failed
#   2  Another run holds the lock
#   3  Usage error

set -euo pipefail

usage() {
  sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'
}

is_git_checkout() {
  local dir="${1:-}"
  [[ -n "$dir" && -d "$dir" ]] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

# True when the tree has changes other than an untracked Bridge config
# (bridge.config.json / .bridge.config.json — the documented default).
is_dirty_ignoring_bridge_config() {
  local dir="$1"
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    case "$line" in
      '?? bridge.config.json'|'?? .bridge.config.json'|'?? "bridge.config.json"'|'?? ".bridge.config.json"')
        continue
        ;;
    esac
    return 0
  done < <(git -C "$dir" status --porcelain)
  return 1
}

resolve_branch() {
  local dir="$1"
  local resolved="$branch"
  if [[ -z "$resolved" ]]; then
    resolved="$(git -C "$dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  fi
  if [[ -z "$resolved" ]]; then
    resolved="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ "$resolved" == "HEAD" ]]; then
      resolved=""
    fi
  fi
  if [[ -z "$resolved" ]]; then
    resolved="main"
  fi
  printf '%s' "$resolved"
}

# Update an isolated clone. Never run this against a developer's checkout.
checkout_isolated_ref() {
  local dir="$1"
  local ref="$2"
  git -C "$dir" fetch --prune origin >/dev/null 2>&1 || true
  if git -C "$dir" rev-parse --verify "origin/$ref" >/dev/null 2>&1; then
    git -C "$dir" checkout --detach "origin/$ref"
    git -C "$dir" reset --hard "origin/$ref"
  else
    git -C "$dir" checkout --detach "$ref"
    git -C "$dir" reset --hard "$ref"
  fi
}

abs_path() {
  local target="$1"
  local parent
  parent="$(cd "$(dirname "$target")" && pwd)"
  printf '%s/%s' "$parent" "$(basename "$target")"
}

config_basename() {
  case "$(basename "$1")" in
    .bridge.config.json)
      printf '%s' '.bridge.config.json'
      ;;
    *)
      printf '%s' 'bridge.config.json'
      ;;
  esac
}

config_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    printf '%s' 'unavailable'
  fi
}

# Resolve --config, the developer's current checkout, or the known
# schedule/configs location. Re-copy on every run so a leftover file in
# the isolated workdir cannot hide a newer checkout config.
install_bridge_config() {
  local dest="$1"
  local src=""
  local dest_name="bridge.config.json"
  local used="$dest"

  if [[ -n "$config_path" ]]; then
    src="$config_path"
  elif [[ -n "$source_repo" && -f "$source_repo/bridge.config.json" ]]; then
    src="$source_repo/bridge.config.json"
  elif [[ -n "$source_repo" && -f "$source_repo/.bridge.config.json" ]]; then
    src="$source_repo/.bridge.config.json"
  elif [[ -f "$known_config_dir/bridge.config.json" ]]; then
    src="$known_config_dir/bridge.config.json"
  elif [[ -f "$known_config_dir/.bridge.config.json" ]]; then
    src="$known_config_dir/.bridge.config.json"
  elif [[ -f "$known_config_file" ]]; then
    src="$known_config_file"
  elif [[ -f "$dest/bridge.config.json" ]]; then
    used="$dest/bridge.config.json"
    echo "Using config: $used (sha256:$(config_sha256 "$used"))"
    return 0
  elif [[ -f "$dest/.bridge.config.json" ]]; then
    used="$dest/.bridge.config.json"
    echo "Using config: $used (sha256:$(config_sha256 "$used"))"
    return 0
  else
    return 0
  fi

  if [[ ! -f "$src" ]]; then
    echo "error: --config is not a readable file: $src" >&2
    exit 3
  fi

  dest_name="$(config_basename "$src")"
  cp "$src" "$dest/$dest_name"
  used="$dest/$dest_name"
  echo "Installed config: $used"
  echo "Using config: $src (sha256:$(config_sha256 "$used"))"
}

# Parse this invocation's run-id from Bridge output. Do not pick the newest
# summary on disk — concurrent or earlier runs can be newer.
extract_run_id() {
  local log="$1"
  local line=""
  local found=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ /runs/([^/[:space:]]+)/bridge-summary\.md ]]; then
      found="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ /runs/([^/[:space:]]+)/bridge-report ]]; then
      found="${BASH_REMATCH[1]}"
    fi
  done < "$log"
  printf '%s' "$found"
}

acquire_lock() {
  if mkdir "$lockdir" 2>/dev/null; then
    echo "$$" > "$lockdir/pid"
    return 0
  fi

  local stale_pid=""
  if [[ -f "$lockdir/pid" ]]; then
    stale_pid="$(tr -cd '0-9' < "$lockdir/pid" 2>/dev/null || true)"
  fi

  if [[ -z "$stale_pid" ]] || kill -0 "$stale_pid" 2>/dev/null; then
    echo "error: another Bridge daily run holds $lockdir" >&2
    exit 2
  fi

  # Atomically take the stale directory. Only one process can rename it.
  local stale_copy="$lockdir.stale.$$"
  if mv "$lockdir" "$stale_copy" 2>/dev/null; then
    local moved_pid=""
    if [[ -f "$stale_copy/pid" ]]; then
      moved_pid="$(tr -cd '0-9' < "$stale_copy/pid" 2>/dev/null || true)"
    fi
    if [[ "$moved_pid" == "$stale_pid" ]] && ! kill -0 "$moved_pid" 2>/dev/null; then
      rm -rf "$stale_copy"
      if mkdir "$lockdir" 2>/dev/null; then
        echo "$$" > "$lockdir/pid"
        return 0
      fi
    else
      # We snatched a lock that is no longer the stale one — put it back.
      mv "$stale_copy" "$lockdir" 2>/dev/null || true
    fi
  fi

  echo "error: another Bridge daily run holds $lockdir" >&2
  exit 2
}

release_lock() {
  if [[ -d "$lockdir" ]]; then
    rm -rf "$lockdir"
  fi
}

# Local mode: never `git checkout`, `git worktree`, or branch creation in the
# developer's repo. Always use a dedicated plain clone under --workdir.
prepare_local_workdir() {
  local source="$1"
  local source_abs
  source_abs="$(cd "$source" && pwd)"

  if [[ -d "$workdir" ]]; then
    local workdir_abs
    workdir_abs="$(cd "$workdir" && pwd)"
    if [[ "$workdir_abs" == "$source_abs" ]]; then
      workdir="$bridge_home/schedule/repos/$repo_name"
    fi
  fi

  if [[ -d "$workdir" ]]; then
    local workdir_abs
    workdir_abs="$(cd "$workdir" && pwd)"
    if [[ "$workdir_abs" == "$source_abs" ]]; then
      echo "error: refusing to run inside the developer's checkout: $source_abs" >&2
      exit 1
    fi
  fi

  if is_dirty_ignoring_bridge_config "$source_abs"; then
    echo "error: refusing to run in a dirty worktree: $source_abs" >&2
    exit 1
  fi

  # Reuse a previous dedicated clone. Replace leftover linked worktrees so
  # Bridge never shares the developer's .git (that created bridge/patch-*
  # branches in the source repo and failed with "already used by worktree").
  if is_git_checkout "$workdir"; then
    if [[ -d "$workdir/.git" ]]; then
      checkout_isolated_ref "$workdir" "$branch"
      return 0
    fi
    git -C "$source_abs" worktree remove --force "$workdir" >/dev/null 2>&1 || rm -rf "$workdir"
  fi

  mkdir -p "$(dirname "$workdir")"
  if [[ -d "$workdir" ]]; then
    rmdir "$workdir" 2>/dev/null || true
  fi
  if [[ -e "$workdir" ]]; then
    echo "error: workdir exists and is not a git checkout: $workdir" >&2
    exit 1
  fi

  git clone "$source_abs" "$workdir"
  local origin_url=""
  origin_url="$(git -C "$source_abs" remote get-url origin 2>/dev/null || true)"
  if [[ -n "$origin_url" ]]; then
    git -C "$workdir" remote set-url origin "$origin_url"
  fi
  checkout_isolated_ref "$workdir" "$branch"
}

prepare_url_workdir() {
  if ! is_git_checkout "$workdir"; then
    mkdir -p "$(dirname "$workdir")"
    if [[ -d "$workdir" ]]; then
      rmdir "$workdir" 2>/dev/null || true
    fi
    git clone "$repo" "$workdir"
  fi
  git -C "$workdir" fetch --prune origin
  branch="$(resolve_branch "$workdir")"
  git -C "$workdir" checkout "$branch"
  git -C "$workdir" reset --hard "origin/$branch"
}

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo=""
branch=""
workdir=""
summary_dir=""
config_path="${BRIDGE_DAILY_CONFIG:-}"
bridge_bin="${BRIDGE_BIN:-}"
skip_before_scripts=1
dry_run=0
notify=0
extra_args=()
source_repo=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo="${2:-}"
      shift 2
      ;;
    --branch)
      branch="${2:-}"
      shift 2
      ;;
    --workdir)
      workdir="${2:-}"
      shift 2
      ;;
    --summary-dir)
      summary_dir="${2:-}"
      shift 2
      ;;
    --config)
      config_path="${2:-}"
      shift 2
      ;;
    --bridge)
      bridge_bin="${2:-}"
      shift 2
      ;;
    --skip-before-scripts)
      skip_before_scripts=1
      shift
      ;;
    --run-before-scripts)
      skip_before_scripts=0
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --notify)
      notify=1
      shift
      ;;
    --no-notify)
      notify=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      extra_args+=("$@")
      break
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 3
      ;;
  esac
done

repo="${repo:-${BRIDGE_DAILY_REPO:-}}"

if [[ -z "$repo" ]]; then
  echo "error: --repo is required" >&2
  usage >&2
  exit 3
fi

if [[ -n "$config_path" ]]; then
  if [[ ! -f "$config_path" ]]; then
    echo "error: --config is not a readable file: $config_path" >&2
    exit 3
  fi
  config_path="$(abs_path "$config_path")"
fi

bridge_home="${BRIDGE_HOME:-$HOME/.bridge}"
mkdir -p \
  "$bridge_home/schedule/locks" \
  "$bridge_home/schedule/repos" \
  "$bridge_home/schedule/summaries" \
  "$bridge_home/schedule/configs"

repo_name="$(basename "$repo")"
repo_name="${repo_name%.git}"
repo_name="$(printf '%s' "$repo_name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+|-+$//g')"
if [[ -z "$repo_name" ]]; then
  repo_name="repo"
fi

workdir="${workdir:-$bridge_home/schedule/repos/$repo_name}"
summary_dir="${summary_dir:-$bridge_home/schedule/summaries/$repo_name}"
lockdir="$bridge_home/schedule/locks/${repo_name}.lock"
known_config_dir="$bridge_home/schedule/configs/$repo_name"
known_config_file="$bridge_home/schedule/configs/${repo_name}.json"

if [[ -z "$bridge_bin" ]]; then
  if command -v bridge >/dev/null 2>&1; then
    bridge_bin="bridge"
  elif [[ -f "$script_dir/../bin/bridge.js" ]]; then
    node_bin="$(command -v node 2>/dev/null || true)"
    if [[ -z "$node_bin" ]]; then
      for candidate in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
        if [[ -x "$candidate" ]]; then
          node_bin="$candidate"
          break
        fi
      done
    fi
    if [[ -z "$node_bin" ]]; then
      echo "error: bridge is not on PATH and node was not found" >&2
      exit 1
    fi
    bridge_bin="$node_bin $script_dir/../bin/bridge.js"
  else
    echo "error: bridge is not on PATH and bin/bridge.js was not found" >&2
    exit 1
  fi
fi

acquire_lock
trap release_lock EXIT

mkdir -p "$summary_dir"

if is_git_checkout "$repo"; then
  source_repo="$(cd "$repo" && pwd)"
  branch="$(resolve_branch "$source_repo")"
  prepare_local_workdir "$source_repo"
else
  source_repo=""
  prepare_url_workdir
fi

install_bridge_config "$workdir"

patch_args=(patch)
if [[ "$skip_before_scripts" -eq 1 ]]; then
  patch_args+=(--skip-before-scripts)
fi
if [[ "$dry_run" -eq 1 ]]; then
  patch_args+=(--dry-run)
fi
if [[ ${#extra_args[@]} -gt 0 ]]; then
  patch_args+=("${extra_args[@]}")
fi

# Split $bridge_bin so a "node /path/bin/bridge.js" fallback stays one command.
# shellcheck disable=SC2206
bridge_cmd=($bridge_bin)

output_log="$lockdir/output.log"
set +e
set +o pipefail
(
  cd "$workdir"
  "${bridge_cmd[@]}" "${patch_args[@]}"
) 2>&1 | tee "$output_log"
bridge_status="${PIPESTATUS[0]}"
set -o pipefail
set -e

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
dest="$summary_dir/$stamp"
mkdir -p "$dest"

run_id=""
if [[ -f "$output_log" ]]; then
  run_id="$(extract_run_id "$output_log")"
fi
run_dir=""
if [[ -n "$run_id" && -d "$bridge_home/runs/$run_id" ]]; then
  run_dir="$bridge_home/runs/$run_id"
fi

if [[ -n "$run_dir" && -f "$run_dir/bridge-summary.md" ]]; then
  cp "$run_dir/bridge-summary.md" "$dest/bridge-summary.md"
  if [[ -f "$run_dir/bridge-report.v1.json" ]]; then
    cp "$run_dir/bridge-report.v1.json" "$dest/bridge-report.v1.json"
  fi
  printf '%s\n' "$run_id" > "$dest/run-id.txt"
  printf '%s\n' "$run_dir" > "$dest/source-run.txt"
  echo "Captured run-id: $run_id"
  echo "Saved summary: $dest/bridge-summary.md"
else
  echo "warning: no bridge-summary.md for this run under $bridge_home/runs" >&2
fi

latest_summary="$bridge_home/schedule/LATEST.md"
if [[ -f "$latest_summary" ]]; then
  echo "Daily summary: $latest_summary"
fi

# Inside `bridge schedule run` (BRIDGE_BATCH_ID set) the batch runner sends one
# notification for the whole batch, so a per-repo one here would be a duplicate.
if [[ -n "${BRIDGE_BATCH_ID:-}" ]]; then
  :
elif [[ "$notify" -eq 1 || "${BRIDGE_NOTIFY:-}" == "1" || -n "${BRIDGE_NOTIFY_COMMAND:-}" ]]; then
  notify_body="Bridge daily run finished"
  if [[ -n "$run_id" ]]; then
    notify_body="Bridge $repo_name ($run_id) finished"
  fi
  if [[ -n "${BRIDGE_NOTIFY_COMMAND:-}" ]]; then
    BRIDGE_SUMMARY_PATH="$latest_summary" \
      BRIDGE_NOTIFY_TITLE="Bridge" \
      BRIDGE_NOTIFY_BODY="$notify_body" \
      BRIDGE_SUMMARY_TEXT="$(cat "$latest_summary" 2>/dev/null || true)" \
      eval "$BRIDGE_NOTIFY_COMMAND" || true
  elif command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$notify_body\" with title \"Bridge\"" || true
  fi
fi

if [[ "$bridge_status" -ne 0 ]]; then
  echo "error: bridge patch exited $bridge_status" >&2
fi

exit "$bridge_status"
