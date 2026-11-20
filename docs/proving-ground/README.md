# The Bridge proving ground

The proving ground tests Bridge the way customers use it: many real GitHub
repositories, Bridge running unattended in GitHub Actions on a schedule, every run
producing raw data that agents analyze. It runs entirely on free, GitHub-hosted
runners in public repositories. See `docs/proving-ground/TASK.md` for the full spec and
`proving-ground/AGENTS.md` for how analysis agents read the data.

## How it fits together

- **The fleet** is a set of public repositories in a dedicated org (`fleetOrg` in
  `proving-ground/config.json`). Each is generated from a catalog entry + template.
- **The engine** (this repo) holds the orchestrator workflows and the scripts they run.
  Orchestrator workflows trigger only on `schedule` / `workflow_dispatch`, so secrets
  are never reachable from a fork PR.
- **The data repo** (`dataRepo`, public, in the fleet org) is append-only:
  `records/runs.jsonl`, `reports/`, `scoreboard.json`.

```
provision  ->  run (reset + dispatch)  ->  Bridge runs in each fixture  ->  collect  ->  score
 pg-provision      pg-run                     fixture bridge.yml              pg-collect   pg-report
```

- `pg-provision` (dispatch): create/update the data repo + every fixture repo from the
  catalog, set the `FLEET_BOT_TOKEN` org secret, enable Actions + auto-merge. Idempotent.
- `pg-run` (daily + dispatch): reset `reset`-mode fixtures to `baseline`, then dispatch
  each fixture's `bridge.yml`, at most `config.concurrency` at a time.
- `pg-collect` (hourly): download artifacts, read the PR and its CI conclusion, merge
  green PRs on `steady` fixtures, append run records.
- `pg-report` (daily + weekly): score the records, write the markdown report, and once a
  week attach a `raw-YYYY-Www.tar.zst` snapshot as a release asset.

Everything the privileged half needs is `FLEET_TOKEN`, a fine-grained PAT stored as an
Actions secret on this repo. You run locally with your own `gh` login and trigger the
privileged work as workflows: `gh workflow run pg-provision.yml`, watched with
`gh run watch`.

## Add a fixture

1. Add a template under `proving-ground/templates/<ecosystem>/<name>/`: real code that
   uses its dependencies, tests that would catch a breaking change, and a committed
   `bridge.config.json` (the single source of truth for install + checks). For a planted
   case, depend on an `@pg/*` package from `proving-ground/registry/packages/` and set
   `usesMockRegistry: true`.
2. Add `proving-ground/catalog/fixtures/<id>.json` (schema:
   `proving-ground/schema/fixture.schema.json`). The `id` is the fleet repo name.
3. Check it generates cleanly:

   ```bash
   npm run pg:generate -- --fixture <id> --out /tmp/pg
   ```

   The generator emits the repo tree: `bridge.config.json`, `.bridge-fixture.json`, a
   `ci.yml` that runs install + checks, and a `workflow_dispatch`-only `bridge.yml`.
4. Provision just that fixture (creates/updates the repo, locks to the drift date, tags
   `baseline`):

   ```bash
   gh workflow run pg-provision.yml -f fixture=<id>
   gh run watch
   ```

`npm test` must still pass, and `npm run pg:generate` must produce a tree for every
fixture.

## Run an experiment against a branch

To test an unreleased Bridge branch across the whole fleet, dispatch `pg-run` with
`bridge_ref`. The reusable workflow runs the CLI from that `cmccoy02/bridge-cli` ref
instead of the pinned action; the engine repository is always `cmccoy02/bridge-cli`.

```bash
gh workflow run pg-run.yml -f experiment_id=my-branch-test -f bridge_ref=my-branch
# a subset, and/or a time-machine date:
gh workflow run pg-run.yml -f experiment_id=replay-2025-06 -f as_of=2025-06-01 -f fixtures=js-npm-express-api,ts-yarn-lib
gh run watch
```

`experiment_id` and `fixture-id` land in the report as `report.experiment`, so every
run traces back to the experiment that produced it. `as_of` runs `bridge patch --as-of`
(npm/pnpm/Yarn resolve with `before = asOf - cooldownDays`; uv uses `UV_EXCLUDE_NEWER`).

Collect and score the experiment the same way the daily loop does:

```bash
gh workflow run pg-collect.yml -f fixtures=js-npm-express-api,ts-yarn-lib
gh workflow run pg-report.yml -f date=$(date -u +%F)
```

## Pull the data

```bash
npm run pg:pull -- --since 7d --out ~/bridge-pg-data
```

Downloads `records/`, `reports/`, `scoreboard.json`, and the recent `raw-*` release
assets (`raw/<experimentId>/<fixtureId>/<runId>/`). Then analyze per
`proving-ground/AGENTS.md`.

## The mock registry

Planted `@pg/*` packages are served by an in-job mock npm registry
(`proving-ground/registry/`): it packs each planted package into a real npm tarball and
serves packuments with publish times backdated from `ages.json`, so the release-age
cooldown cases are reproducible. A fixture that uses it gets a self-contained `.pg/`
copy and a `setup-registry.sh` that starts it on `localhost:4873` before Bridge (and in
the fixture's own `ci.yml`, so bot PRs are testable). Baselines are aged two years so
they lock cleanly under any drift date; only the planted version is recent.

The canary scenario plants fake honeytokens (`pg-honeytoken-<run id>`) into the update
job and ships a package whose postinstall records which token-like variables it can
see. Bridge scrubs them from package scripts, so the canary should see none; any
honeytoken in a report, log, artifact or PR body is a critical `honeytoken-leak`.

## Known dynamics

- On a live (non-`--as-of`) run, the 3-day release-age cooldown can block a
  clean-drift update when a transitive dependency published in the last few days. That
  is correct product behaviour; the time machine gives deterministic experiments.
- Precise drift-date locking exists for npm (`--before`) and uv (`--exclude-newer`).
  pnpm/Yarn get the npm-style `before` best-effort; poetry/pip-compile/pipenv/mix lock
  to the latest at provision time (they still drift as upstream moves on).
- Bridge's cooldown verification only queries the public registry, so planted `@pg`
  versions show as `unverified`; the in-job registry's native cooldown still picks the
  settled version. Querying the configured registry is a Phase 2 Bridge task.
