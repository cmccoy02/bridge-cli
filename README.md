# Bridge CLI

Automated, non-breaking dependency updates. One command. One PR.

Bridge copies your current repository into an isolated temp environment, updates dependencies using your config, and pushes a PR-ready branch without touching your local working directory.

## Quick Start

1. Install:

```bash
npm install -g bridge-cli
```

If `bridge` conflicts with another local binary, use:

```bash
bridge-cli --help
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
- Clean the copied repo snapshot and fast-forward from origin when available
- Anchor patching to origin's default branch (typically `main`/`master`)
- Clean/install/update/reinstall using config commands
- Run optional scripts
- Create branch, commit, push
- Print compare URL and final summary
- Always cleanup temp directory

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
- `repoUrl` (if omitted, Bridge uses `origin` from git)
- `beforeScripts`
- `afterScripts`
- `branchPrefix` (defaults to `bridge/patch`)
- `scopes` (additional nested directories to patch in the same run)

Notes:
- If `bridge.config.json` is not tracked yet, Bridge will include it in the patch commit automatically.

## Config Examples

### Node.js (npm)

```json
{
  "packageManager": "npm",
  "installCommand": "npm install",
  "updateCommand": "npm update",
  "cleanCommands": ["rm -rf node_modules", "rm -f package-lock.json"]
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
3. Clean and sync the copied snapshot from origin (when available)
4. Run your configured clean/install/update commands
5. Commit and push a branch only if changes exist
6. Cleanup temp directory

No language-specific core logic. Your config defines the workflow.

## Why Bridge?

Dependency maintenance is necessary but repetitive. Bridge removes the manual churn so engineers can focus on feature delivery instead of routine package bumping.

- No local workspace risk
- No ecosystem-specific branching in the engine
- One config pattern for Node, Python, Elixir, and more
