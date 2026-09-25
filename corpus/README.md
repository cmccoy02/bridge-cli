# Bridge Corpus

A test harness for running Bridge CLI against deterministic fixtures without affecting upstream repositories.

## Purpose

The corpus provides:
- **Isolated testing**: Run `bridge patch --dry-run` against controlled fixtures
- **CI integration**: Automated runs via GitHub Actions (weekdays + PRs to corpus/)
- **Regression detection**: Scoreboard tracks fixture outcomes over time
- **Policy validation**: Test guardrails like `allowMajorUpdates: false`

## Quick Start

```bash
# First-time setup: initialize fixture git repos (required once)
node corpus/scripts/setup-fixtures.mjs

# Run all fixtures (from repo root)
node corpus/scripts/run-all.mjs

# Run a single fixture
node corpus/scripts/run-fixture.mjs clean-outdated

# Run with verbose output
node corpus/scripts/run-all.mjs --verbose
```

## Directory Structure

```
corpus/
├── fixtures/           # Test fixtures (each is a mini npm project)
│   ├── clean-outdated/     # Outdated dep that should be patched
│   ├── up-to-date/         # Nothing to update (early exit)
│   ├── preexisting-fail/   # Failing script before+after (baseline noise)
│   ├── skip-major/         # Tests allowMajorUpdates policy
│   └── .remotes/           # Bare git repos for fixture remotes (gitignored)
├── scripts/
│   ├── setup-fixtures.mjs  # Initialize fixture git repos (run once)
│   ├── run-fixture.mjs     # Run single fixture
│   └── run-all.mjs         # Run all fixtures, generate scoreboard
├── artifacts/          # Generated outputs (gitignored)
│   ├── scoreboard.json     # Summary of all fixture runs
│   └── <fixture>-result.json   # Per-fixture detailed results
└── README.md
```

## Adding a New Fixture

1. Create a new directory under `corpus/fixtures/`:
   ```bash
   mkdir corpus/fixtures/my-new-fixture
   ```

2. Add minimal `package.json`:
   ```json
   {
     "name": "corpus-my-new-fixture",
     "version": "1.0.0",
     "private": true,
     "description": "Fixture: describe what this tests",
     "scripts": {
       "lint": "exit 0",
       "test": "exit 0"
     },
     "dependencies": {
       "some-package": "1.0.0"
     }
   }
   ```

3. Add `bridge.config.json`:
   ```json
   {
     "name": "corpus-my-new-fixture",
     "packageManager": "npm",
     "installCommand": "npm ci",
     "updateCommand": "npm update",
     "cleanCommands": ["rm -rf node_modules"],
     "beforeScripts": ["npm run lint"],
     "afterScripts": ["npm run lint", "npm run test"],
     "allowMajorUpdates": false,
     "pullRequest": { "enabled": false }
   }
   ```

4. Generate lockfile:
   ```bash
   cd corpus/fixtures/my-new-fixture
   npm install --package-lock-only
   ```

5. (Optional) Add `EXPECTED_BEHAVIOR.md` documenting what Bridge should do.

## Fixture Guidelines

- **Keep fixtures minimal**: Only include dependencies needed to test a specific behavior
- **Pin versions**: Use exact versions in package.json for reproducibility
- **Disable PRs**: Set `pullRequest.enabled: false` to avoid remote operations
- **Document expectations**: Add EXPECTED_BEHAVIOR.md for non-obvious scenarios
- **Use descriptive names**: Fixture name should indicate what it tests

## Scoreboard

After running, `corpus/artifacts/scoreboard.json` contains:

```json
{
  "schemaVersion": "corpus-scoreboard.v1",
  "generatedAt": "2024-01-01T00:00:00.000Z",
  "summary": {
    "total": 4,
    "patched": 2,
    "upToDate": 1,
    "failed": 1,
    "error": 0
  },
  "results": [...]
}
```

Status values:
- `patched`: Bridge found and applied updates
- `up_to_date`: No updates needed (early exit)
- `failed`: Bridge policy violation or validation failure
- `error`: Fixture setup or harness error

## Future: Frozen Forks

The corpus is designed to eventually include 10+ frozen fork fixtures pointing to pinned commits of real-world projects. These would live under `corpus/fixtures/` with git submodule or sparse checkout configurations.

Example structure (not yet implemented):
```
corpus/fixtures/
├── frozen-lodash-v4.17.20/
├── frozen-express-v4.18.0/
└── ...
```

## CI Integration

The `.github/workflows/corpus.yml` workflow:
- Runs on `workflow_dispatch` (manual trigger)
- Runs on schedule (weekdays at 06:00 UTC)
- Runs on PRs that modify `corpus/**`
- Uploads artifacts and scoreboard
- Never pushes to external remotes
