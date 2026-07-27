# Bridge CLI

Automated, non-breaking dependency updates. One command. One PR.

Bridge copies the remote default branch into an isolated temp environment, updates dependencies using your config, runs security and reliability gates, and pushes a PR-ready branch without touching your local working directory.

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

3. Run a patch:

```bash
bridge patch
```

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
- Commit and push only through the protected-branch guard
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

### `bridge config`

Prints the current `bridge.config.json` to the terminal.

Bridge also writes local operation logs to:
- `~/.bridge/logs/operations.log`

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
8. Commit and push through the protected-branch guard only if every gate passes
9. Cleanup temp directory and any first-init local config copy

No language-specific core logic. Your config defines the workflow.

## Why Bridge?

Dependency maintenance is necessary but repetitive. Bridge removes the manual churn so engineers can focus on feature delivery instead of routine package bumping.

- No local workspace risk
- No ecosystem-specific branching in the engine
- One config pattern for Node, Python, Elixir, and more
