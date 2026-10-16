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
#                         $BRIDGE_HOME/schedule/repos/<name>).
#   --summary-dir <dir>   Dated summary destination (default:
#                         $BRIDGE_HOME/schedule/summaries/<name>).
#   --bridge <cmd>        Bridge executable (default: bridge on PATH, else
#                         this repo's bin/bridge.js).
#   --skip-before-scripts Pass --skip-before-scripts to Bridge (default: on).
#   --run-before-scripts  Do not pass --skip-before-scripts.
#   --dry-run             Pass --dry-run to Bridge (no commit/push/PR).
#   --                    Extra arguments forwarded to `bridge patch`.
#
# Environment:
#   BRIDGE_HOME           Artifact root (default: ~/.bridge).
#   BRIDGE_BIN            Override for --bridge.
#   BRIDGE_DAILY_REPO     Override for --repo.
#
# Exit codes:
#   0  Bridge succeeded
#   1  Bridge or repo setup failed
#   2  Another run holds the lock
#   3  Usage error

set -euo pipefail

usage() {
  sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
}

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo=""
branch=""
workdir=""
summary_dir=""
bridge_bin="${BRIDGE_BIN:-}"
skip_before_scripts=1
dry_run=0
extra_args=()

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

bridge_home="${BRIDGE_HOME:-$HOME/.bridge}"
mkdir -p "$bridge_home/schedule/locks" "$bridge_home/schedule/repos" "$bridge_home/schedule/summaries"

repo_name="$(basename "$repo")"
repo_name="${repo_name%.git}"
repo_name="$(printf '%s' "$repo_name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+|-+$//g')"
if [[ -z "$repo_name" ]]; then
  repo_name="repo"
fi

workdir="${workdir:-$bridge_home/schedule/repos/$repo_name}"
summary_dir="${summary_dir:-$bridge_home/schedule/summaries/$repo_name}"
lockdir="$bridge_home/schedule/locks/${repo_name}.lock"

if [[ -z "$bridge_bin" ]]; then
  if command -v bridge >/dev/null 2>&1; then
    bridge_bin="bridge"
  elif [[ -f "$script_dir/../bin/bridge.js" ]]; then
    bridge_bin="$(command -v node) $script_dir/../bin/bridge.js"
  else
    echo "error: bridge is not on PATH and bin/bridge.js was not found" >&2
    exit 1
  fi
fi

release_lock() {
  if [[ -d "$lockdir" ]]; then
    rm -rf "$lockdir"
  fi
}

if ! mkdir "$lockdir" 2>/dev/null; then
  stale_pid=""
  if [[ -f "$lockdir/pid" ]]; then
    stale_pid="$(cat "$lockdir/pid" 2>/dev/null || true)"
  fi
  if [[ -n "$stale_pid" ]] && ! kill -0 "$stale_pid" 2>/dev/null; then
    rm -rf "$lockdir"
    if ! mkdir "$lockdir" 2>/dev/null; then
      echo "error: another Bridge daily run holds $lockdir" >&2
      exit 2
    fi
  else
    echo "error: another Bridge daily run holds $lockdir" >&2
    exit 2
  fi
fi

echo "$$" > "$lockdir/pid"
trap release_lock EXIT

mkdir -p "$workdir" "$summary_dir"

if [[ -d "$repo/.git" ]]; then
  # Existing local checkout. Fetch and fast-forward only; never reset --hard.
  workdir="$(cd "$repo" && pwd)"
  if [[ -n "$(git -C "$workdir" status --porcelain)" ]]; then
    echo "error: refusing to run in a dirty worktree: $workdir" >&2
    exit 1
  fi
  git -C "$workdir" fetch --prune origin
  if [[ -z "$branch" ]]; then
    branch="$(git -C "$workdir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  fi
  if [[ -z "$branch" ]]; then
    branch="$(git -C "$workdir" rev-parse --abbrev-ref HEAD)"
  fi
  git -C "$workdir" checkout "$branch"
  git -C "$workdir" pull --ff-only origin "$branch"
else
  # URL (or missing local path): clone once, then fetch + hard-reset to origin.
  if [[ ! -d "$workdir/.git" ]]; then
    git clone "$repo" "$workdir"
  fi
  git -C "$workdir" fetch --prune origin
  if [[ -z "$branch" ]]; then
    branch="$(git -C "$workdir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"
  fi
  if [[ -z "$branch" ]]; then
    branch="main"
  fi
  git -C "$workdir" checkout "$branch"
  git -C "$workdir" reset --hard "origin/$branch"
fi

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

set +e
(
  cd "$workdir"
  "${bridge_cmd[@]}" "${patch_args[@]}"
)
bridge_status=$?
set -e

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
dest="$summary_dir/$stamp"
mkdir -p "$dest"

latest_summary=""
if [[ -d "$bridge_home/runs" ]]; then
  for candidate in "$bridge_home"/runs/*/bridge-summary.md; do
    [[ -f "$candidate" ]] || continue
    if [[ -z "$latest_summary" || "$candidate" -nt "$latest_summary" ]]; then
      latest_summary="$candidate"
    fi
  done
fi

if [[ -n "$latest_summary" && -f "$latest_summary" ]]; then
  cp "$latest_summary" "$dest/bridge-summary.md"
  run_dir="$(dirname "$latest_summary")"
  if [[ -f "$run_dir/bridge-report.v1.json" ]]; then
    cp "$run_dir/bridge-report.v1.json" "$dest/bridge-report.v1.json"
  fi
  printf '%s\n' "$run_dir" > "$dest/source-run.txt"
  echo "Saved summary: $dest/bridge-summary.md"
else
  echo "warning: no bridge-summary.md found under $bridge_home/runs" >&2
fi

if [[ "$bridge_status" -ne 0 ]]; then
  echo "error: bridge patch exited $bridge_status" >&2
fi

exit "$bridge_status"
