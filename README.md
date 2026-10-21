# Bridge CLI

The safe local pilot for dependency maintenance. One command, clear evidence,
and a reviewable candidate branch for every passing update.

Bridge copies the remote default branch into an isolated temp environment,
updates dependencies using your config, runs security and reliability gates,
pushes a candidate branch, and creates a pull request when GitHub CLI is already
authenticated—all without touching your local working directory.

PR creation is pinned to the repository represented by `origin`, so a local
run against a fork opens the PR on that fork instead of relying on GitHub CLI's
upstream inference.

## Quick Start

1. Install from the npm registry:

```bash
npm install -g @connormccoy/bridge
```

Or run without installing:

```bash
npx @connormccoy/bridge --help
```

For local source testing from this repository:

```bash
npm install -g .
bridge --help
```

2. Initialize Bridge in your project:

```bash
cd your-project
bridge init
```

3. Check the project setup, simulate a patch, then run it for real:

```bash
bridge doctor
bridge patch --dry-run
bridge patch
bridge report --latest
```

`bridge patch` updates, validates, commits, and pushes a candidate branch only
when every configured gate passes. The pull request remains the human approval
boundary. Use `--dry-run` to run the same flow without committing or pushing.

### Travelpass pilot

From `/Users/connormccoy/CODE/travelpass.com`, the ready-to-run local pilot is:

```bash
bridge doctor --local-package @travelpass/design-system=../travelpass-design-system-master

bridge patch --dry-run --scope . \
  --local-package @travelpass/design-system=../travelpass-design-system-master

bridge report --latest
```

The design system is used only inside Bridge's isolated workspace. Its normal
registry reference is restored before comparison or staging, so no local path
can enter a candidate branch. Remove any `.git` metadata from the local design
system copy before linking it.

## Commands

### `bridge --version`

Prints the package version. From a git checkout this includes the short commit
SHA, for example `0.1.0 (0b81b32)`.

### `bridge init`

Interactive onboarding that creates `bridge.config.json` in the current directory.

Auto-detection before prompts:
- `package.json` `packageManager` -> `npm`/`yarn`/`pnpm` (highest priority)
- `package-lock.json` -> `npm`
- `yarn.lock` -> `yarn`
- `pnpm-lock.yaml` -> `pnpm`
- `requirements.txt` -> `pip`
- `mix.exs` -> `mix`
- `package.json` `name` -> pre-fills `name`

### `bridge patch`

Runs the patch engine end-to-end:
- Copy to temp dir
- Fetch origin and resolve the configured default branch
- Check out and pull the current default branch tip
- Delete local temp branches except the default branch
- Create and check out the Bridge patch branch before updates run
- Capture the pre-update vulnerability and Visualizer baselines
- Install the committed lockfile baseline, then run `beforeScripts`
- Update dependencies and install the candidate tree, then run `afterScripts`
- Diff before vs after: only NEW after-script failures block push/PR, including new error output inside a command that already failed on the baseline. Time-varying noise (`Start at HH:MM:SS`, TAP `duration_ms`, ISO/epoch timestamps, `(node:PID)` warnings, host:port pairs, heap/size numbers, UUIDs, temp paths) is normalized so pre-existing failing vitest/node:test suites do not false-positive
- Print a compact after-script table at the end of every run (name, pass/fail, new vs baseline, duration, full log path) and write the same rows to `bridge-report.v1.json` plus `bridge-summary.md`
- Hide untracked `bridge.config.json` from the isolated workspace so repo lint/format scripts do not fail on Bridge's own config
- Stage only dependency manifests and lockfiles, never paths under `node_modules/`
- Reject direct major-version changes, new vulnerabilities, and configured bundle regressions (npm, pnpm, and yarn lockfiles). Yarn classic lockfiles are keyed by package name, so a range rewrite such as `semver@^6` → `semver@^7` is a major bump
- Save a detailed, redacted `bridge-report.v1.json` for the run, including blocked-run validation/gate evidence
- Save full redacted stdout and stderr for every failing command when a run is blocked
- Exit before candidate reinstall/after-scripts when the lockfile did not change
- `--block-on-baseline-failures` stops after the committed baseline, before the update
- Commit and push only through the protected-branch guard after every gate passes
- Reuse an open Bridge PR with identical changes. Update it only when the hidden scope marker matches and the branch contains only Bridge commits (a `Bridge-Commit: true` trailer, or Bridge's own author identity — not merely the PR author's name on Bridge's subject). A narrower run opens a new PR instead of replacing a broader one. Older duplicate matching PRs are flagged in the output. If `gh pr list` fails (including GitHub's GraphQL node-limit error), Bridge surfaces the error, does not push the candidate branch, and exits non-zero so it cannot open a silent duplicate
- Refresh PR bodies through `gh api` (REST) rather than `gh pr edit`, and never print a success check when the body update failed
- Create a pull request through an existing GitHub CLI session when available
- Print pull request/compare URLs and final summary, using the reused PR's branch name when one is updated
- Always cleanup the temp directory, including on SIGINT/SIGTERM, and write a partial cancelled report
- Ignore copied git worktree metadata so a worktree in the source repo cannot break `clean_base`

Useful modes:

```bash
# Exercise the complete workflow without committing or pushing.
bridge patch --dry-run

# Stream underlying command output and preserve the isolated repo for debugging.
bridge patch --dry-run --verbose --keep-workspace

# Treat baseline script failures as blocking instead of noise.
bridge patch --block-on-baseline-failures

# Skip configured beforeScripts; capture baseline by running afterScripts
# on the committed lockfile tree (reversible; default remains off).
bridge patch --skip-before-scripts

# Exercise one declared service without running every configured scope.
bridge patch --dry-run --scope deploy/description_bot

# Replace a private npm package only inside the isolated run.
bridge patch --dry-run \
  --local-package @travelpass/design-system=../travelpass-design-system-master

# Run the update, validation, commit, and safe candidate-branch push.
bridge patch
```

Local-package substitutions require a package directory without `.git` metadata.
Bridge validates the package name, uses the local source for installation and
tests, then restores the registry manifest and lockfile entries before metrics
or staging. The local path is rejected if it appears in the candidate diff.

### `bridge validate`

Validates config and runtime prerequisites.

- Checks required config fields
- Checks command availability in PATH
- Optionally checks repo reachability (skip with `--offline`)

### `bridge doctor`

The local-pilot setup check. It performs the same config and tool checks as
`bridge validate`, plus validates every requested `--local-package` link:

- package path exists and contains the declared npm package name;
- package is declared by the target project;
- local copy contains no `.git` metadata;
- package version and resolved location are displayed before a run starts.

```bash
bridge doctor --local-package @travelpass/design-system=../travelpass-design-system-master
```

### `bridge report --latest`

Shows the most recent detailed run report: status, duration, candidate branch,
dependency/audit/bundle results, and artifact locations. Add `--json` for the
raw `bridge-report.v1` document or pass a run ID to inspect a specific run.

### `bridge config`

Prints the current `bridge.config.json` to the terminal.

Bridge also writes local operation logs to:
- `~/.bridge/logs/operations.log`

Each `bridge patch` run additionally writes:

- `~/.bridge/runs/<run-id>/bridge-report.v1.json` — main run report with outcomes
- `~/.bridge/runs/<run-id>/bridge-summary.md` — compact after-script table for humans and scheduled runs
- `~/.bridge/runs/<run-id>/scripts/*.log` — full redacted stdout/stderr for each validation script
- `~/.bridge/runs/<run-id>/bridge-agent.v1.jsonl` — append-only event stream for agent consumption
- `~/.bridge/runs/<run-id>/failure.log` when a command fails
- `~/.bridge/artifacts/<run-id>/...` for Visualizer reports

Set `BRIDGE_HOME` to store all of these local artifacts somewhere else. Reports
are redacted before writing and are the stable data contract for a future Bridge
Console.

### Agent Telemetry (`bridge-agent.v1`)

The `bridge-agent.v1.jsonl` file is an append-only event stream designed for
AI agents and automation tools to recursively improve Bridge from real run data.
Each line is a self-contained JSON event with:

- `schemaVersion`: `"bridge-agent.v1"`
- `runId`: unique run identifier
- `timestamp`: ISO 8601 timestamp
- `elapsedMs`: milliseconds since run start
- `event`: event type (see below)

**Event types:**

| Event | Description |
|-------|-------------|
| `run_started` | Run begins; includes detailed environment info |
| `phase_completed` | A phase finished; includes timing and status |
| `early_exit` | Run exited early; includes reason code |
| `gate_decision` | Audit/validation gate result; includes pass/fail |
| `config_state` | Config file status at end; includes SHA256, staged, mutated |
| `dependency_delta_summary` | Aggregated dependency change metrics |
| `run_finished` | Run completed; includes final status and duration |

**Extended report fields (in `bridge-report.v1.json`):**

The main report now includes additional agent-friendly fields:

```json
{
  "agentSchemaVersion": "bridge-agent.v1",
  "git": {
    "baseBranch": "main",
    "branchName": "bridge/patch-2026-09-25-1430",
    "baseSha": "abc123",
    "headSha": "def456",
    "stagedFiles": ["package.json", "package-lock.json"]
  },
  "config": {
    "path": "/path/to/bridge.config.json",
    "sha256": "e3b0c442...",
    "staged": false,
    "mutated": false
  },
  "outcome": {
    "earlyExit": null,
    "skippedCount": 0,
    "blockedCount": 0
  },
  "phaseTiming": {
    "commit": { "durationMs": 1234, "status": "success" },
    "pr": { "durationMs": 567, "status": "success" }
  },
  "agentEventStream": "~/.bridge/runs/<run-id>/bridge-agent.v1.jsonl"
}
```

**Early exit reason codes:**

| Code | Description |
|------|-------------|
| `no_updates` | No dependency updates found across all scopes |
| `up_to_date` | All dependencies already at latest versions |
| `lockfile_unchanged` | Lockfile unchanged after update command |
| `no_python_changes` | No Python requirement changes detected |
| `policy_block` | Blocked by policy violation (major updates, etc.) |
| `audit_block` | Blocked by security audit regression |
| `bundle_block` | Blocked by bundle size regression |
| `validation_block` | Blocked by validation script failure |

These artifacts are designed for agents to understand why a run succeeded,
failed, or exited early — enabling automated triage and self-improvement loops.

## Config Reference

File: `bridge.config.json` (or `.bridge.config.json`)

```json
{
  "name": "my-project",
  "packageManager": "npm",
  "installCommand": "npm ci",
  "updateCommand": "npm update",
  "cleanCommands": [
    "rm -rf node_modules"
  ],
  "beforeScripts": [],
  "afterScripts": [],
  "skipBeforeScripts": false,
  "auditCommand": "npm audit --package-lock-only --json",
  "blockOnNewVulnerabilities": true,
  "blockOnBaselineFailures": false,
  "allowMajorUpdates": false,
  "pullRequest": {
    "enabled": true,
    "draft": false
  },
  "bundleAnalysis": {
    "command": "ANALYZE=true npm run build",
    "reportPath": "dist/analyze.html",
    "metric": "brotli",
    "maxIncreasePercent": 5
  },
  "branchPrefix": "bridge/patch"
}
```

Required fields:
- `packageManager`
- `installCommand`
- `updateCommand`
- `cleanCommands`

Optional fields:
- `name`
- `beforeScripts`
- `afterScripts` (see [docs/after-scripts.md](docs/after-scripts.md) for the recommended lint / test / build / typecheck / format-check suite)
- `skipBeforeScripts` (defaults to `false`; when `true`, configured `beforeScripts` do not run and Bridge captures the baseline by running `afterScripts` on the committed lockfile tree. CLI: `--skip-before-scripts` / `--run-before-scripts`)
- `auditCommand` (npm defaults to `npm audit --package-lock-only --json`; pnpm to `pnpm audit --json`; yarn to `yarn audit --json`)
- `blockOnNewVulnerabilities` (defaults to `true`)
- `blockOnBaselineFailures` (defaults to `false`; when true, pre-existing baseline script failures stop the run after the baseline, before the update)
- `auditBlockingSeverities` (defaults to `["critical", "high"]`; severity levels that block when increased)
- `allowMajorUpdates` (defaults to `false`; applies to direct dependencies)
- `transitiveMajorPolicy` (defaults to `"warn"`; options: `"block"`, `"warn"`, `"allow"`)
- `configRetentionPolicy` (defaults to `"keep"`; options: `"keep"`, `"delete"`)
- `pullRequest` (defaults to enabled; optional `{ "draft": true, "title": "...", "body": "..." }`)
- `bundleAnalysis` (optional `rollup-plugin-visualizer` adapter and before/after comparison)
- `branchPrefix` (defaults to `bridge/patch`)
- `scopes` (additional nested directories to patch in the same run)
- `pythonZeroMajor` (how the Python requirements updater treats `0.x` pins): `"skip"` (default) leaves them byte-identical; `"patch"` keeps major+minor and updates the patch; `"minor"` allows minor updates while keeping major zero.

### Git-derived settings (deprecated in config)

The following fields are now derived from git and do not need to be specified in config:

- `repoUrl` — derived from `git remote get-url origin`
- `defaultBranch` — derived from `refs/remotes/origin/HEAD` or `git remote show origin`
- `protectedBranches` — Bridge only opens PRs and never pushes directly to protected branches

If these fields are present in legacy configs, Bridge treats them as optional overrides but prefers the git-derived values. You can safely remove these fields from your config.

Notes:
- **Config immutability**: `bridge.config.json` is treated as user-owned and immutable during a patch run. Bridge will not rewrite, expand, or merge inferred fields back onto disk.
- **Untracked config not committed**: If `bridge.config.json` is untracked, Bridge isolates it out of the working tree (`.git/bridge/`) before validation so `eslint .` / `prettier --check .` see a clean repo. Patch commits only include dependency manifests and lockfiles.
- If `bridge.config.json` is already tracked, Bridge leaves your local copy in place.
- Visualizer HTML reports are copied to `~/.bridge/artifacts/<run-id>/<scope>/` and are not added to the patch.
- `beforeScripts` execute against the committed-lockfile baseline after install-as-needed, and before any update/candidate mutation. `afterScripts` execute after the candidate is installed. Only NEW after-script failures block push/PR. That includes new error lines inside a command that already failed on the baseline. Pre-existing identical baseline failures are reported as already-present and non-blocking unless `blockOnBaselineFailures` is enabled. A command that appears only in `afterScripts` is described as not measured on the baseline, not as "introduced by the update".
- `skipBeforeScripts: true` (or `--skip-before-scripts`) leaves the before-script code path in place but does not execute `beforeScripts`. Comparison still works because Bridge runs the after-script suite on the committed lockfile tree as the baseline, then again on the candidate. Default is `false` so PRs that established before-on-baseline behavior stay unchanged unless you opt in.
- When clean commands remove a supported lockfile, Bridge restores the committed baseline before the before scripts (or the skipped-before baseline capture) and restores the candidate lockfile before the after scripts. This prevents `npm install` from resolving an updated dependency tree on both sides of the comparison.
- npm, pnpm, and yarn lockfiles are parsed for dependency deltas and the direct-major gate. Yarn classic entries are aggregated by package name. `bridge doctor` warns when a lockfile format cannot be parsed or when no audit command is configured *and* the package manager has no default. Empty `auditCommand` on npm/pnpm/yarn still runs the default audit during `bridge patch`.
- `bridge --version` prints `0.1.0 (<git sha>)` from a git checkout.
- When a run is blocked, `failure.log` includes the failing command's stdout and stderr, the report records `validation` / `gateDecisions` / `blockedCount`, and the terminal prints a short excerpt of failing lines (both streams).
- The Visualizer lives only in `bundleAnalysis`, not in `beforeScripts` or `afterScripts`. Bridge runs it after those arrays on both sides, so it is the last optional validation step rather than a duplicate build path.
- `bridge patch` pushes only a protected-branch-guarded candidate branch after every gate passes. Use `--dry-run` for a non-mutating simulation.

### P0 reliability features

These features were added to make `bridge patch` hands-off enough for weekly automation:

#### Early exit on no updates

If the update step finds no dependency changes across all scopes, Bridge exits before candidate reinstall, after-scripts, and Visualizer with a clear "No dependencies to update" message. The summary does not print a branch that was never created.

#### Branch naming with timestamps

Branch names now include a time component for uniqueness: `bridge/patch-YYYY-MM-DD-HHMM` (e.g., `bridge/patch-2026-09-18-0930`). This prevents collisions when running Bridge multiple times on the same day (morning/evening runs).

#### Config immutability

`bridge.config.json` is treated as user-owned and immutable during a patch run:
- Bridge will not auto-add optional defaults or merge inferred fields back onto disk
- Untracked config files are not staged into patch commits
- The config file's contents are preserved exactly as written

#### Before/after script diff

Bridge now captures baseline script results (exit codes and normalized failure output) before the update and compares them with after-update results. Only NEW failures block push/PR:

- Pre-existing baseline failures with the same normalized error set are reported as non-blocking noise
- Clock times, ISO timestamps, pids, ports, and TAP/vitest duration fields are stripped before comparison
- A command that still fails but gained new error lines is a NEW failure and hard-stops before push/PR
- When output changed and Bridge cannot prove it is the same failure, it blocks (conservative)
- Resolved failures (failures that now pass) are reported as improvements
- `blockOnBaselineFailures: true` or `--block-on-baseline-failures` stops after the baseline, before the update, with consistent blocking copy

This prevents flaky or pre-existing lint/test failures from blocking otherwise-good patches, while making a candidate regression an obvious stop.

#### Severity-aware audit gate

The vulnerability audit now compares by severity bucket, not just total count:

```json
{
  "blockOnNewVulnerabilities": true,
  "auditBlockingSeverities": ["critical", "high"]
}
```

- By default, only increases in `critical` or `high` severity block the patch
- Increases in `moderate` or `low` are logged but do not block
- Terminal and PR output shows per-severity deltas (e.g., "critical: +1, high: -2")

#### Transitive major policy

Bridge now detects major version bumps in transitive dependencies:

```json
{
  "transitiveMajorPolicy": "warn"
}
```

- `"block"`: Fail the patch if any transitive dependency has a major bump
- `"warn"` (default): Log a warning but allow the patch
- `"allow"`: No logging, allow transitive majors silently

This catches cases like `@babel/runtime` going 7→8 via a direct dependency update.

#### Doctor/validate hardening

`bridge doctor` and `bridge validate` now check:

- Git `user.name` and `user.email` are configured (required for commits)
- GitHub CLI (`gh`) is installed and authenticated when PR creation is enabled
- npm version, with guidance if using a version with known Arborist bugs
- Lockfile metrics / the direct-major gate are inactive because the lockfile format cannot be parsed
- `auditCommand` is empty, which disables the vulnerability gate
- `afterScripts` includes commands that were never measured on the baseline

#### Durable config lifecycle

The local `bridge.config.json` is now kept by default after a successful push:

```json
{
  "configRetentionPolicy": "keep"
}
```

- `"keep"` (default): Keep the local config file for weekly automation
- `"delete"`: Delete the untracked config after successful push (legacy behavior)

#### Richer reports and PR body

The `bridge-report.v1.json` and PR body now include:

- Node/npm versions and platform info (`environment.npmVersion` is filled from `npm --version`)
- Gate decisions with pass/fail status and reasons, including on blocked runs
- Script diff outcomes (new failures, output-changed failures, baseline noise, resolved)
- Audit severity deltas per scope
- Package from→to table, bundle-size delta, and the local report path
- Phase timing information

If an open Bridge PR already has an identical diff, Bridge reuses it instead of opening a duplicate. If the same files changed with a new patch, Bridge updates that PR's branch. Open-PR lookup lists metadata only (no commit payloads) and loads commits per candidate; a GitHub CLI list failure is surfaced and Bridge refuses to open a silent duplicate.

### Pull request creation

Bridge creates a pull request after a successful candidate-branch push when
`pullRequest.enabled` is not `false`. It uses an existing `gh` session or
`GH_TOKEN`/`GITHUB_TOKEN`; Bridge never opens an interactive GitHub login or
changes your Git credentials. If `gh` is missing or unauthenticated, the branch
still pushes safely and Bridge prints the compare URL plus an actionable notice.
Bridge passes the normalized `origin` repository explicitly to GitHub CLI and
reuses an already-open PR when a retry reaches the PR-creation step again, and reuses or updates an open Bridge PR whose changes match the current patch.

Git credentials alone cannot create a pull request because creation uses the
GitHub API. A one-time `gh auth login` or a scoped token is therefore required
only for automatic PR creation. Disable it per repository with:

```json
{ "pullRequest": false }
```

### Visualizer bundle regression gate

Bridge currently supports the HTML output from
[`rollup-plugin-visualizer`](https://github.com/btd/rollup-plugin-visualizer).
Configure the optional adapter with the build command and report path; do not
put the same command in the before/after arrays:

```json
{
  "bundleAnalysis": {
    "command": "ANALYZE=true npm run build",
    "reportPath": "dist/analyze.html",
    "metric": "brotli",
    "maxIncreasePercent": 5,
    "maxIncreaseBytes": 51200
  }
}
```

Bridge runs the configured before/after arrays first, then runs the Visualizer
build on each side, preserves both HTML reports for visual inspection, prints
rendered/gzip/brotli totals, and blocks the patch if either configured threshold
is exceeded. It is intentionally optional and currently does not claim support
for Webpack/Rolldown-specific report formats or Python package analysis. Omit
`maxIncreaseBytes` if the percentage threshold is sufficient.

## Config Examples

### Node.js (npm)

```json
{
  "packageManager": "npm",
  "installCommand": "npm ci",
  "updateCommand": "npm update",
  "cleanCommands": ["rm -rf node_modules"],
  "auditCommand": "npm audit --package-lock-only --json",
  "blockOnNewVulnerabilities": true,
  "allowMajorUpdates": false
}
```

### Node.js (pnpm)

```json
{
  "packageManager": "pnpm",
  "installCommand": "pnpm install",
  "updateCommand": "pnpm update",
  "cleanCommands": ["rm -rf node_modules"],
  "auditCommand": "pnpm audit --json",
  "blockOnNewVulnerabilities": true,
  "allowMajorUpdates": false
}
```

### Python (pip)

```json
{
  "packageManager": "pip",
  "installCommand": ".bridge-venv/bin/python -m pip install --upgrade pip && .bridge-venv/bin/python -m pip install -r requirements.txt",
  "updateCommand": ".bridge-venv/bin/python -m pip install --upgrade -r requirements.txt && .bridge-venv/bin/python -m pip freeze --exclude-editable | grep -Ev \"^(pip|setuptools|wheel)==\" > requirements.txt",
  "cleanCommands": ["rm -rf .bridge-venv", "python3 -m venv .bridge-venv"]
}
```

### Elixir (mix)

```json
{
  "packageManager": "mix",
  "installCommand": "mix deps.get",
  "updateCommand": "mix deps.update --all",
  "cleanCommands": ["rm -rf deps", "rm -rf _build", "rm -f mix.lock"]
}
```

### Nested Python Scope Inside a TypeScript Repo

```json
{
  "packageManager": "pnpm",
  "installCommand": "pnpm install --frozen-lockfile",
  "updateCommand": "pnpm update",
  "cleanCommands": ["rm -rf node_modules"],
  "scopes": [
    {
      "path": "deploy/description_bot",
      "packageManager": "pip",
      "installCommand": ".bridge-venv/bin/python -m pip install --upgrade pip && .bridge-venv/bin/python -m pip install -r requirements.txt",
      "updateCommand": ".bridge-venv/bin/python -m pip install --upgrade -r requirements.txt && .bridge-venv/bin/python -m pip freeze --exclude-editable | grep -Ev \"^(pip|setuptools|wheel)==\" > requirements.txt",
      "cleanCommands": ["rm -rf .bridge-venv", "python3 -m venv .bridge-venv"]
    }
  ]
}
```

## How It Works

Bridge is intentionally simple and deterministic:

1. Read `bridge.config.json`
2. Copy repo into an isolated temp directory
3. Fetch origin, check out/pull the default branch, and create a Bridge branch
4. Install a reproducible before-update baseline from the committed lockfile
5. Run `beforeScripts` on that baseline (unless `skipBeforeScripts` / `--skip-before-scripts`, in which case the after-script suite is the baseline measurement), then the optional Visualizer baseline
6. Update dependencies and install the candidate tree
7. Run `afterScripts`, then the optional Visualizer candidate build
8. Compare dependency, vulnerability, bundle, and validation results — NEW after-script failures stop before push/PR
9. Write a redacted report, compact after-script summary, per-script logs, and failure evidence for the local run
10. Commit/push through the protected-branch guard, then create a PR when existing GitHub API credentials are available
11. Cleanup temp directory and any first-init local config copy

No language-specific core logic. Your config defines the workflow.

## Why Bridge?

Dependency maintenance is necessary but repetitive. Bridge removes the manual churn so engineers can focus on feature delivery instead of routine package bumping.

- No local workspace risk
- No ecosystem-specific branching in the engine
- One config pattern for Node, Python, Elixir, and more

## Compact after-script summary

Noisy lint/test/build logs stay in per-script files. Every `bridge patch` run ends with a CI-style table:

```
After-script summary
Script         Result  Failure   Duration  Log
npm run lint   pass    —         1.2s      ~/.bridge/runs/<run-id>/scripts/afterscripts-root-01-npm-run-lint.log
npm run test   fail    new       4.8s      ~/.bridge/runs/<run-id>/scripts/afterscripts-root-02-npm-run-test.log
npm run build  fail    baseline  12.1s     ~/.bridge/runs/<run-id>/scripts/afterscripts-root-03-npm-run-build.log
```

`Failure` is `new` (blocks push/PR), `baseline` (already present; not blocking unless `blockOnBaselineFailures`), `unmeasured` (after-only command, no baseline row), or `—` (passed). The same rows are in `outcome.scriptSummary` of `bridge-report.v1.json` and in `bridge-summary.md`. Scheduled runs can copy that markdown file. This is result capture only — no adoption tracking yet.

```bash
bridge patch --dry-run
bridge report --latest
```

## Daily scheduler prototype

`scripts/bridge-daily.sh` is a lockfile-guarded wrapper: fetch/pull (or clone) a target repo, run `bridge patch` with the after-script suite, copy **this run's** `bridge-summary.md` to a dated folder. No daemon, no cloud scheduler, no extra npm dependencies. It exits `2` if another run holds the lock, `3` on usage errors, and Bridge's own non-zero status on a failed patch. It never force-pushes a PR; the normal gates still apply.

The wrapper defaults to `--skip-before-scripts` so an unattended daily run matches the temporary "strip before-scripts" path. Pass `--run-before-scripts` to keep the configured before-script list.

Local `--repo` paths never run `git checkout`, `git worktree`, or branch creation in the developer's tree. The wrapper always uses a dedicated plain clone under `~/.bridge/schedule/repos/<name>` and leaves the user's current branch alone. An untracked `bridge.config.json` (Bridge's documented default) is ignored by the dirty-tree check; other uncommitted changes still refuse.

Config is resolved fresh on every run and the chosen path plus sha256 are logged. `--config` wins when given. Otherwise the wrapper re-copies the developer's current checkout `bridge.config.json`, then `~/.bridge/schedule/configs/<repo-name>/`. A leftover copy in `~/.bridge/schedule/repos/<name>` is never preferred over those sources.

A fresh URL clone has no config. Pass `--config <path>`, or place one at `~/.bridge/schedule/configs/<repo-name>/bridge.config.json`.

```bash
# URL clone — supply a config (typical repos do not commit one):
scripts/bridge-daily.sh --repo git@github.com:travelpassgroup/travelpass.com.git --branch main \
  --config /Users/connormccoy/CODE/travelpass.com/bridge.config.json

# Existing checkout (dedicated clone; does not switch your branch):
scripts/bridge-daily.sh --repo /Users/connormccoy/CODE/travelpass.com --run-before-scripts

# Simulate without commit/push:
scripts/bridge-daily.sh --repo /path/to/repo --dry-run --config /path/to/bridge.config.json
```

Dated copies land in `~/.bridge/schedule/summaries/<repo>/<UTC-timestamp>/` and include `run-id.txt` for the captured run.

### macOS launchd (primary)

1. `mkdir -p ~/.bridge/schedule/logs`
2. Copy `scripts/schedule/com.bridge.daily.plist.example` to `~/Library/LaunchAgents/com.bridge.daily.plist`
3. Replace `REPLACE_*` values (this repo path, the target git URL, the Bridge config path, `$HOME`)
4. Load it:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.bridge.daily.plist
launchctl enable gui/$(id -u)/com.bridge.daily
# Optional immediate run:
launchctl kickstart -k gui/$(id -u)/com.bridge.daily
```

The example fires daily at 07:30 local time. The Mac must be awake. To unload: `launchctl bootout gui/$(id -u)/com.bridge.daily`.

### Linux cron

See `scripts/schedule/crontab.example`. Cron's default PATH does not include `node`; the example PATH starts with `REPLACE_NODE_BIN_DIR`. After `crontab -e`:

```
PATH=REPLACE_NODE_BIN_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
30 7 * * * /bin/bash /path/to/bridge-cli/scripts/bridge-daily.sh --repo git@github.com:org/app.git --branch main --config /path/to/bridge.config.json >> $HOME/.bridge/schedule/logs/daily.log 2>&1
```

## Isolated-workspace gotchas

### node_modules / clean / install sequencing

Verified in the current `bridge patch` order (not a guess):

1. Copy into the temp workspace **excludes** `node_modules` (and venvs). The developer's local install is never the baseline.
2. `cleanCommands` (typically `rm -rf node_modules`) run next. On a fresh copy this is usually a no-op; it matters when a previous step created `node_modules`.
3. If clean deleted a supported lockfile, Bridge restores the **committed** lockfile before install.
4. `installCommand` installs that committed lockfile. Baseline scripts therefore see a clean install of HEAD, not a leftover tree.
5. If install rewrote the lockfile, Bridge restores the committed bytes again so the update starts from HEAD.
6. `beforeScripts` run here — after that install — unless skipped. When skipped, the **after-script suite** runs at this same point as the baseline measurement.
7. Update mutates the lockfile / `node_modules`.
8. Candidate clean + restore of the **updated** lockfile + install, then `afterScripts`.

Edge cases that are still easy to get wrong (documented, not changed here):

- Capturing a script baseline *before* step 4 produces false failures (no `node_modules`) or measures the wrong tree. That is the historical sequencing bug; current code installs first.
- Putting `rm -rf node_modules` in `beforeScripts` themselves leaves later baseline scripts and the Visualizer on an empty tree.
- `audit_before` still runs *before* the baseline install. That is fine for `npm audit --package-lock-only`. A live `npm audit` that needs `node_modules` can look empty on the before side.
- `skipBeforeScripts` avoids a second script list that can mutate the tree between baseline install and update. Comparison stays valid because the after-script suite is what gets measured on both sides.

### Pre-commit hooks (lefthook, husky, …)

Git hooks copied into the isolated workspace do not reliably run the same way as on a normal laptop checkout. The temp tree starts without `node_modules`; hooks that call `npx lefthook`, `./node_modules/.bin/lefthook`, or a `prepare`-installed husky shim only work if `installCommand` actually installs those packages and runs lifecycle scripts. `npm ci --ignore-scripts`, a no-op install, or a hook path that assumes the consumer's global toolchain will silently skip. Bridge treats this as a consumer-owned concern: keep required checks in `afterScripts` (and CI), not only in pre-commit.
