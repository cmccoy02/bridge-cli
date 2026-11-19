# Bridge CLI

Bridge keeps a repository's dependencies patched and only opens a pull request it
has already proven safe: it updates in an isolated copy, runs the repo's own
checks before and after (baseline-aware: only new failures block), applies
security/size/cooldown gates, then pushes `bridge/...` and opens or refreshes one PR.

This repo is the engine (public, MIT). The private console lives in
`cmccoy02/bridge-console` (`v2` branch): GitHub App, token broker, run ledger.

## Commands

```bash
npm ci
npm test                 # node:test, ~35s, no network
npm run smoke            # bridge --help
node bin/bridge.js ...   # run from source
```

## Layout

- `bin/bridge.js` – commander wiring.
- `src/commands/patch.js` – the main flow. `runScopeWorkflow` per scope:
  audit → clean → baseline install → baseline checks → update (with native
  cooldown env) → reinstall → deltas → direct-major gate → transitive-major gate →
  **cooldown gate** → audit → after checks → bundle size. `patchCommand` copies the
  repo to a temp dir, prepares a clean base, stages only manifests/lockfiles, then
  either pushes + opens a PR (local mode) or writes a handoff bundle (`--handoff`).
- `src/commands/publish.js` – `bridge publish <dir>`: privileged half of CI.
  Validates the bundle, gets a token, commits as the bot, pushes, opens/updates
  the PR, uploads the report. Never runs package code.
- `src/core/executor.js` – `runCommand`. Scrubs GitHub/Actions/Bridge tokens from
  every command unless `trusted: true` (only git network ops and `gh`).
- `src/core/cooldown.js` – release-age cooldown (native settings + registry
  publish-time check for npm and PyPI).
- `src/core/handoff.js` – bundle format `bridge-handoff.v1` and its validation.
- `src/core/cloud.js` – console client: OIDC token, token broker, report upload.
- `src/core/runReport.js` – `bridge-report.v1` (now includes
  `outcome.dependencyDeltas`, `outcome.cooldown`, `repository`, `ci`; publish adds
  `publish`).
- `src/core/pullRequest.js` – PR body, reuse/dedupe logic via `gh`.
- `action.yml` – composite action (`mode: update | publish`).
- `.github/workflows/bridge.yml` – reusable two-job workflow customers call.
- `docs/ci.md` – the CI security model. Read it before touching publish/handoff.

## Rules

- Anything that runs package code must go through `runCommand` without
  `trusted`. Only mark a call trusted if it needs a GitHub credential and runs no
  repository code (git push/fetch/ls-remote, gh).
- `bridge publish` must never install dependencies or run repo scripts, and must
  keep treating the bundle as untrusted (paths, hashes, branch names, manifest
  sections).
- Never print local filesystem paths into PR bodies.
- Keep the report schema additive (`bridge-report.v1`); the console ingests it.
- Tests use `node:test`; no network. Mock `fetch` and `gh` (see
  `test/cloudConnect.test.js`).

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `BRIDGE_API_URL` | patch, publish | Console base URL (broker + ledger) |
| `BRIDGE_API_TOKEN` | patch (local) | Console API key for uploads outside Actions |
| `BRIDGE_GITHUB_TOKEN` | publish | Use this token instead of the broker |
| `BRIDGE_OIDC_AUDIENCE` | publish | Defaults to the origin of `BRIDGE_API_URL` |
| `BRIDGE_HOME` | all | Run history (default `~/.bridge`) |

## Open work

- Rebuild the PR package table in `publish` from the lockfile diff (trusted).
- Cut a `v0` tag; pin the reusable workflow to it.
- Pick the npm package scope and publish; drop `github:` installs from docs.
- `bridge init` for Python projects should detect `pytest`/`ruff`.
