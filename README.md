# Bridge CLI

Automated, non-breaking dependency updates. One command. One PR.

Bridge clones your repository into an isolated temp environment, updates dependencies using your config, and pushes a PR-ready branch without touching your local working directory.

## Quick Start

1. Install:

```bash
npm install -g bridge-cli
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
- `package-lock.json` -> `npm`
- `yarn.lock` -> `yarn`
- `pnpm-lock.yaml` -> `pnpm`
- `requirements.txt` -> `pip`
- `mix.exs` -> `mix`
- `.git/config` origin URL -> pre-fills `repoUrl`
- `package.json` `name` -> pre-fills `name`

### `bridge patch`

Runs the patch engine end-to-end:
- Clone to temp dir
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

## Config Reference

File: `bridge.config.json`

```json
{
  "name": "my-project",
  "repoUrl": "git@github.com:user/my-project.git",
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
- `repoUrl`
- `packageManager`
- `installCommand`
- `updateCommand`
- `cleanCommands`

Optional fields:
- `name`
- `beforeScripts`
- `afterScripts`
- `branchPrefix` (defaults to `bridge/patch`)

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
  "installCommand": "pip install -r requirements.txt",
  "updateCommand": "pip install --upgrade -r requirements.txt",
  "cleanCommands": ["rm -rf venv", "python -m venv venv"]
}
```

### Elixir (mix)

```json
{
  "packageManager": "mix",
  "installCommand": "mix deps.get",
  "updateCommand": "mix deps.update --all",
  "cleanCommands": ["rm -rf deps", "rm -rf _build"]
}
```

## How It Works

Bridge is intentionally simple and deterministic:

1. Read `bridge.config.json`
2. Clone repo into an isolated temp directory
3. Run your configured clean/install/update commands
4. Commit and push a branch only if changes exist
5. Cleanup temp directory

No language-specific core logic. Your config defines the workflow.

## Why Bridge?

Dependency maintenance is necessary but repetitive. Bridge removes the manual churn so engineers can focus on feature delivery instead of routine package bumping.

- No local workspace risk
- No ecosystem-specific branching in the engine
- One config pattern for Node, Python, Elixir, and more
