# Scheduling Bridge: two approaches

There is no daemon and no cloud scheduler. The OS clock starts Bridge; Bridge
still applies every gate before a PR can open. Scheduled runs **skip
before-scripts by default** (confirmed intended). Pass `--run-before-scripts`
only when you want the configured before-script list.

Two ways to attach the clock. Keep both; pick one.

## A. Embedded CLI (`bridge schedule`)

`bridge schedule install --repo <url> --config <path>` writes a LaunchAgent
(macOS) or a cron snippet (`~/.bridge/schedule/crontab.bridge` on Linux). The
generated unit calls `bridge schedule run`, which can take **multiple repos**
and run them concurrently (default 2).

```bash
bridge schedule install --repo git@github.com:org/app.git \
  --config ~/CODE/app/bridge.config.json --time 07:30 --runner cli

# Preview only:
bridge schedule install --repo git@github.com:org/app.git --config ./bridge.config.json --print

# Run now (same skip-before-scripts default as launchd/cron):
bridge schedule run --repo git@github.com:org/app.git --repo git@github.com:org/other.git \
  --concurrency 2 --dry-run

bridge schedule latest
bridge schedule uninstall
```

On macOS, load the written plist:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bridge.daily.plist
launchctl enable gui/$(id -u)/com.bridge.daily
```

On Linux, paste `~/.bridge/schedule/crontab.bridge` into `crontab -e`. Bridge
never overwrites your existing crontab.

## B. Modular runner (`scripts/bridge-daily.sh`)

A 500-line Bash wrapper plus example units:

- `scripts/schedule/com.bridge.daily.plist.example`
- `scripts/schedule/crontab.example`

The wrapper takes the per-repo lock, refreshes a **dedicated plain clone**,
re-installs config, runs `bridge patch --skip-before-scripts`, and copies that
run's summary. It does not need the `schedule` subcommand.

```bash
scripts/bridge-daily.sh --repo /path/to/checkout --dry-run
scripts/bridge-daily.sh --repo git@github.com:org/app.git --branch main \
  --config /path/to/bridge.config.json --notify
```

Two different repos can already run at the same time (separate locks). Same
repo still exits 2 if overlapping.

```bash
scripts/bridge-daily.sh --repo /path/to/app-a --dry-run &
scripts/bridge-daily.sh --repo /path/to/app-b --dry-run &
wait
```

## Tradeoffs

| | CLI (`bridge schedule`) | Wrapper (`bridge-daily.sh`) |
| --- | --- | --- |
| Install | One command writes plist/cron | Copy an example file, fill REPLACE_* |
| Multi-repo | `--repo` repeatable, `--concurrency` | One wrapper process per repo |
| Dependencies | Needs `node` + this package | Bash + `node`/`bridge` on PATH |
| Debuggability | Node stack traces | Readable shell, easy to `bash -x` |
| Extra features | Batch wall/RSS, daily digest, notify | Lock, clone, dated summary copy |
| Best when | You want one entry point | You want the scheduler to stay outside the CLI |

Connor can run both side by side: install the CLI unit for one repo and keep the
example LaunchAgent pointed at `bridge-daily.sh` for another.

## Concurrent runs

`bridge patch` already uses a unique temp workspace (`mkdtemp`) and a unique
run id (`command-time-pid-random`). Different repos may run at the same time.
The same repo is serialized by a lock under `~/.bridge/locks/patch/` so two
manual patches cannot clash on branch/PR.

Measure impact: each `bridge-report.v1.json` has `performance` (wall, peak RSS,
CPU user/sys). A `bridge schedule run` batch also prints wall vs sum-of-runs.

## Daily summary and notifications

Every patch rebuilds `~/.bridge/schedule/LATEST.md` (and
`~/.bridge/schedule/summaries/daily/YYYY-MM-DD.md`). That is the file to look
at after an unattended run. GitHub will not notify on private/internal Bridge
PRs; this file plus an optional local hook is the signal.

```bash
# macOS notification, or any command:
bridge schedule run --repo /path/to/app --notify
# or
BRIDGE_NOTIFY_COMMAND='notify-send "$BRIDGE_NOTIFY_TITLE" "$BRIDGE_NOTIFY_BODY"' \
  scripts/bridge-daily.sh --repo /path/to/app --notify
```

A captured sample lives in `docs/daily-summary.sample.md`.
