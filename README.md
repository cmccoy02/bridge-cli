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
- Clean/install/update/reinstall using config commands
- Run blocking before/after validation scripts
- Run the optional Visualizer metric last in each validation phase
- Reject direct major-version changes, new vulnerabilities, and configured bundle regressions
- Save a detailed, redacted `bridge-report.v1.json` for the run
- Save full redacted output when a command fails
- Commit and push only through the protected-branch guard after every gate passes
- Create a pull request through an existing GitHub CLI session when available
- Print pull request/compare URLs and final summary
- Always cleanup temp directory

Useful modes:

```bash
# Exercise the complete workflow without committing or pushing.
bridge patch --dry-run

# Stream underlying command output and preserve the isolated repo for debugging.
bridge patch --dry-run --verbose --keep-workspace

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

- `~/.bridge/runs/<run-id>/bridge-report.v1.json`
- `~/.bridge/runs/<run-id>/failure.log` when a command fails
- `~/.bridge/artifacts/<run-id>/...` for Visualizer reports

Set `BRIDGE_HOME` to store all of these local artifacts somewhere else. Reports
are redacted before writing and are the stable data contract for a future Bridge
Console.

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
  "auditCommand": "npm audit --package-lock-only --json",
  "blockOnNewVulnerabilities": true,
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
- `afterScripts`
- `auditCommand` (npm defaults to `npm audit --package-lock-only --json`)
- `blockOnNewVulnerabilities` (defaults to `true`)
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
- **Untracked config not committed**: If `bridge.config.json` is untracked, Bridge will NOT include it in patch commits. The local untracked copy is kept by default for weekly automation (see `configRetentionPolicy`).
- If `bridge.config.json` is already tracked, Bridge leaves your local copy in place.
- Visualizer HTML reports are copied to `~/.bridge/artifacts/<run-id>/<scope>/` and are not added to the patch.
- `beforeScripts` execute against the freshly installed baseline. `afterScripts` execute after the candidate is installed. Only NEW script failures block the patch; baseline failures are logged as warnings.
- When clean commands remove a supported lockfile, Bridge restores the committed baseline before the before scripts and restores the candidate lockfile before the after scripts. This prevents `npm install` from resolving an updated dependency tree on both sides of the comparison.
- The Visualizer lives only in `bundleAnalysis`, not in `beforeScripts` or `afterScripts`. Bridge runs it after those arrays on both sides, so it is the last optional validation step rather than a duplicate build path.
- `bridge patch` pushes only a protected-branch-guarded candidate branch after every gate passes. Use `--dry-run` for a non-mutating simulation.

### P0 reliability features

These features were added to make `bridge patch` hands-off enough for weekly automation:

#### Early exit on no updates

If the update step finds no dependency changes across all scopes, Bridge exits early with a clear "No dependencies to update" message instead of running the full clean/reinstall/reset path. This saves time and avoids unnecessary noise when dependencies are already current.

#### Branch naming with timestamps

Branch names now include a time component for uniqueness: `bridge/patch-YYYY-MM-DD-HHMM` (e.g., `bridge/patch-2026-09-18-0930`). This prevents collisions when running Bridge multiple times on the same day (morning/evening runs).

#### Config immutability

`bridge.config.json` is treated as user-owned and immutable during a patch run:
- Bridge will not auto-add optional defaults or merge inferred fields back onto disk
- Untracked config files are not staged into patch commits
- The config file's contents are preserved exactly as written

#### Before/after script diff

Bridge now captures baseline script results (exit codes and output) before the update and compares them with after-update results. Only NEW failures block the patch:

- Baseline failures that persist are logged as warnings but do not block
- Resolved failures (failures that now pass) are reported as improvements
- New failures (scripts that fail only after the update) block the patch

This prevents flaky or pre-existing lint/test failures from blocking otherwise-good patches.

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

- Node/npm versions and platform info
- Gate decisions with pass/fail status and reasons
- Script diff outcomes (new failures, baseline noise, resolved)
- Audit severity deltas per scope
- Phase timing information

### Pull request creation

Bridge creates a pull request after a successful candidate-branch push when
`pullRequest.enabled` is not `false`. It uses an existing `gh` session or
`GH_TOKEN`/`GITHUB_TOKEN`; Bridge never opens an interactive GitHub login or
changes your Git credentials. If `gh` is missing or unauthenticated, the branch
still pushes safely and Bridge prints the compare URL plus an actionable notice.
Bridge passes the normalized `origin` repository explicitly to GitHub CLI and
reuses an already-open PR when a retry reaches the PR-creation step again.

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
4. Install and validate a reproducible before-update baseline
5. Run the optional Visualizer baseline after the configured before scripts
6. Update and reinstall dependencies
7. Run configured after scripts, then the optional Visualizer candidate build
8. Compare dependency, vulnerability, bundle, and validation results
9. Write a redacted report and failure evidence for the local run
10. Commit/push through the protected-branch guard, then create a PR when existing GitHub API credentials are available
11. Cleanup temp directory and any first-init local config copy

No language-specific core logic. Your config defines the workflow.

## Why Bridge?

Dependency maintenance is necessary but repetitive. Bridge removes the manual churn so engineers can focus on feature delivery instead of routine package bumping.

- No local workspace risk
- No ecosystem-specific branching in the engine
- One config pattern for Node, Python, Elixir, and more
