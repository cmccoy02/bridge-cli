# Bridge CLI

The safe local pilot for dependency maintenance. One command, clear evidence,
and a reviewable candidate branch for every passing update.

Bridge copies the remote default branch into an isolated temp environment,
updates dependencies using your config, runs security and reliability gates,
and can push a PR-ready branch without touching your local working directory.

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
- Reject direct major-version changes, new vulnerabilities, and configured bundle regressions
- Save a detailed, redacted `bridge-report.v1.json` for the run
- Save full redacted output when a command fails
- Commit and push only through the protected-branch guard after every gate passes
- Print compare URL and final summary
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
  "installCommand": "npm install",
  "updateCommand": "npm update",
  "cleanCommands": [
    "rm -rf node_modules",
    "rm -f package-lock.json"
  ],
  "beforeScripts": [],
  "afterScripts": [],
  "auditCommand": "npm audit --package-lock-only --json",
  "blockOnNewVulnerabilities": true,
  "allowMajorUpdates": false,
  "bundleAnalysis": {
    "command": "ANALYZE=true npm run build",
    "reportPath": "dist/analyze.html",
    "metric": "brotli",
    "maxIncreasePercent": 5
  },
  "branchPrefix": "bridge/patch",
  "defaultBranch": "main",
  "protectedBranches": ["main"]
}
```

Required fields:
- `packageManager`
- `installCommand`
- `updateCommand`
- `cleanCommands`

Optional fields:
- `name`
- `repoUrl` (if omitted, Bridge uses `origin` from git)
- `beforeScripts`
- `afterScripts`
- `auditCommand` (npm defaults to `npm audit --package-lock-only --json`)
- `blockOnNewVulnerabilities` (defaults to `true`)
- `allowMajorUpdates` (defaults to `false`; applies to direct dependencies)
- `bundleAnalysis` (optional `rollup-plugin-visualizer` before/after comparison)
- `branchPrefix` (defaults to `bridge/patch`)
- `defaultBranch` (if omitted, Bridge detects `origin`'s default branch and records it in the PR branch)
- `protectedBranches` (additional branch names Bridge must never push to)
- `scopes` (additional nested directories to patch in the same run)
- `pythonZeroMajor` (how the Python requirements updater treats `0.x` pins): `"skip"` (default) leaves them byte-identical; `"patch"` keeps major+minor and updates the patch; `"minor"` allows minor updates while keeping major zero.

Notes:
- If `bridge.config.json` is not tracked yet, Bridge will include it in the patch commit automatically, then remove the trailing untracked local copy after the PR branch is pushed.
- If `bridge.config.json` is already tracked, Bridge leaves your local copy in place.
- Visualizer HTML reports are copied to `~/.bridge/artifacts/<run-id>/<scope>/` and are not added to the patch.
- `beforeScripts` execute against the freshly installed baseline. `afterScripts` execute after updates. Any failure blocks the patch.
- `bridge patch` pushes only a protected-branch-guarded candidate branch after every gate passes. Use `--dry-run` for a non-mutating simulation.

### Visualizer bundle regression gate

Bridge supports the HTML output from
[`rollup-plugin-visualizer`](https://github.com/btd/rollup-plugin-visualizer).
Configure your build to write a report, then give Bridge the build command and
report path:

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

Bridge runs the build before and after dependency updates, preserves both HTML
reports for visual inspection, prints rendered/gzip/brotli totals, and blocks
the patch if either configured threshold is exceeded. Omit
`maxIncreaseBytes` if the percentage threshold is sufficient.

## Config Examples

### Node.js (npm)

```json
{
  "packageManager": "npm",
  "installCommand": "npm install",
  "updateCommand": "npm update",
  "cleanCommands": ["rm -rf node_modules", "rm -f package-lock.json"],
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
  "installCommand": "pnpm install",
  "updateCommand": "pnpm update",
  "cleanCommands": ["rm -rf node_modules", "rm -f pnpm-lock.yaml"],
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
5. Run vulnerability and Visualizer baselines
6. Update and reinstall dependencies
7. Compare dependency, vulnerability, bundle, and validation results
8. Write a redacted report and failure evidence for the local run
9. Commit and push through the protected-branch guard only if every gate passes
10. Cleanup temp directory and any first-init local config copy

No language-specific core logic. Your config defines the workflow.

## Why Bridge?

Dependency maintenance is necessary but repetitive. Bridge removes the manual churn so engineers can focus on feature delivery instead of routine package bumping.

- No local workspace risk
- No ecosystem-specific branching in the engine
- One config pattern for Node, Python, Elixir, and more
