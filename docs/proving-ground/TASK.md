# Task: build the Bridge proving ground

You are building the system that tests Bridge the way customers use it: many real
GitHub repositories, Bridge running unattended in GitHub Actions on a schedule, and
every run producing raw data that agents can analyze. Connor (owner) wants zero
manual setup beyond what is listed under "What Connor provides", and wants it free.

Read first: `CLAUDE.md`, `docs/ci.md`, `corpus/README.md`,
`.github/workflows/bridge.yml`, `action.yml`, `src/commands/publish.js`.

## Decisions already made (do not re-ask)

- Name: **proving ground**. The test repositories are **the fleet**.
- Everything runs on GitHub-hosted runners in **public** repositories, which are free.
  No servers, no paid services. The mock registry runs inside workflow jobs.
- Fleet repositories live in a dedicated GitHub org. Its name is in
  `proving-ground/config.json` (`fleetOrg`). Never hard-code it.
- Phase 1 does not use the Bridge console or GitHub App. The publish job pushes with
  the `FLEET_TOKEN` personal access token (passed as the reusable workflow's
  `bridge-github-token` secret). Phase 2 switches to the App + broker.
- Real open-source snapshots are **new repositories created by import (mirror push of
  one commit), never GitHub forks**, so no PR can ever target an upstream project.
- Half the synthetic fleet resets to its baseline after every run (measures the first
  run a new customer sees); half auto-merges green Bridge PRs (measures ongoing
  maintenance). Set per fixture with `mode: "reset" | "steady"`.
- Scorecard targets: at least 95% of labeled cases end as expected; at least 60% of
  Bridge PRs on real snapshots pass that repo's own CI untouched; p95 under 15 minutes
  from workflow start to PR; zero honeytoken leaks.
- Ecosystem mix: mostly JS/TS, then Python and Elixir; two Ruby repos as gap
  fixtures in Phase 2 (Bridge has no Ruby support yet; they should record
  `unsupported`, not crash).

## What Connor provides (already done when you start)

1. The fleet org exists; its name is set in `proving-ground/config.json`.
2. A fine-grained personal access token for that org is stored as the Actions secret
   `FLEET_TOKEN` on `cmccoy02/bridge-cli`. Permissions: repository Administration,
   Contents, Pull requests, Workflows, Actions, Issues (read/write) on all org
   repositories; organization Secrets (read/write).
3. You run locally with Connor's `gh` login (owner of `cmccoy02/bridge-cli` and the
   fleet org). You never see `FLEET_TOKEN`; anything that needs it runs as a workflow
   in this repo, which you trigger with `gh workflow run` and watch with `gh run watch`.

If something else is required, stop and ask Connor with exact click-by-click steps.

## Safety rules

- Never open a PR, issue or push against any repository outside the fleet org and
  `cmccoy02/bridge-cli`. Snapshot repos must not be forks.
- No real secrets in fleet repos. The only org secret is `FLEET_BOT_TOKEN` (the same
  token, set by the provision workflow) used by fleet workflows for the publish job.
- Planted "malicious" packages are canaries: they read the environment and write a
  JSON report under `$RUNNER_TEMP/pg-canary/`. No network calls, nothing destructive.
  They are only ever served by the in-job mock registry, never published anywhere.
- Orchestrator workflows in `bridge-cli` trigger only on `schedule` and
  `workflow_dispatch` (secrets must not be reachable from fork pull requests).
- Stay inside free usage: standard runners, public repos, artifacts with
  `retention-days` set, data repo kept small (see Data).

## Layout to create

```
proving-ground/
  config.json                 # fleetOrg, dataRepo, cadence, concurrency
  catalog/fixtures/*.json     # one per fleet repo (schema/fixture.schema.json)
  catalog/scenarios.json      # planted cases and their expected outcomes (provided)
  catalog/snapshots.json      # Phase 2: upstream repo + commit + test command
  schema/                     # fixture + run-record JSON schemas (provided)
  templates/<ecosystem>/<name>/  # generator inputs per fixture template
  registry/packages/          # planted npm packages (@pg/*) and their versions
  scripts/
    provision.mjs             # create/update fleet repos from the catalog
    reset.mjs                 # reset "reset" fixtures to their baseline tag
    dispatch.mjs              # trigger Bridge runs across the fleet
    collect.mjs               # gather results into run records + raw bundles
    score.mjs                 # scorecard + daily/weekly markdown report
    pull-data.mjs             # local: download data repo + raw bundles for agents
  AGENTS.md                   # how analysis agents read the data (provided)
.github/workflows/
  pg-provision.yml            # dispatch; provisions fleet + data repo + org secret
  pg-run.yml                  # daily cron + dispatch: reset, then dispatch runs
  pg-collect.yml              # hourly cron + dispatch: collect finished runs
  pg-report.yml               # daily + weekly cron: score, report, weekly raw release
```

Add `npm run pg:*` scripts for each script. Node 22+, ESM, no new runtime
dependencies for the CLI package; the proving ground may use dev dependencies only.

## Phase 1 (deliver first)

### 1. Bridge hooks the proving ground needs

These are product changes; customers need most of them too. Test each.

- **Language setup in the reusable workflow.** Today the update job only sets up
  Node, so Python and Elixir repos cannot run. Add inputs `python-version`,
  `otp-version`, `elixir-version` (and install uv / Poetry / Pipenv when the repo's
  lockfile calls for them) with conditional setup steps.
- **`setup-script` input**: a path in the caller repo run in the update job before
  Bridge (fleet: start the mock registry; customers: private-registry auth such as
  GCP Artifact Registry). It must never run in the publish job.
- **`bridge-ref` input**: run the CLI from a given `cmccoy02/bridge-cli` ref instead
  of the pinned action, so unreleased branches can be tested on the whole fleet.
- **Experiment metadata**: `BRIDGE_EXPERIMENT_ID`, `BRIDGE_FIXTURE_ID` env vars are
  copied into the report as `report.experiment = { id, fixtureId }`.
- **Final report out of publish**: `bridge publish` writes the final report (with the
  `publish` section) to `<handoff>/bridge-report.final.json`; the workflow uploads it.
- **Raw logs**: both jobs upload `$BRIDGE_HOME/runs/**` (operations JSONL, script logs,
  agent event stream, failure evidence) as artifacts `bridge-logs-update` /
  `bridge-logs-publish` with `if: always()` and `retention-days: 30`.
- **Time machine**: `bridge patch --as-of <ISO date>` runs as if today were that date:
  npm/pnpm/Yarn get `before = asOf - cooldownDays` for the update step (do not also
  set `min-release-age`; npm rejects both), uv gets `--exclude-newer`, the cooldown
  check uses `now = asOf`, and the report records `run.asOf`. Ecosystems without a
  "before" mechanism record `asOfSupported: false` and run live.

### 2. Fixture generator and the first 12 fixtures

Each fleet repo is generated from `catalog/fixtures/<id>.json` and contains real code
that uses its dependencies, tests that would catch a breaking change, a CI workflow
(`ci.yml`, runs install + tests on push and pull_request), a committed
`bridge.config.json`, `.bridge-fixture.json` (copy of the catalog entry), and
`.github/workflows/bridge.yml` calling `cmccoy02/bridge-cli/.github/workflows/bridge.yml@main`
with `workflow_dispatch` inputs `experiment_id`, `bridge_ref`, `as_of` and no cron
(the orchestrator dispatches; that keeps runs countable).

Pin dependencies to the fixture's `driftDate` (`npm install --before`, `uv lock
--exclude-newer`, and the closest equivalent elsewhere) so every fixture starts behind.
The commit Bridge should start from is tagged `baseline`.

First 12 (ids are suggestions; adjust templates if a stack is impractical):

| id | manager | stack | size | drift | mode | planted cases |
|---|---|---|---|---|---|---|
| js-npm-express-api | npm | Express + zod + axios, vitest | S | 6 mo | reset | none |
| js-pnpm-vite-react | pnpm | Vite React SPA, build + vitest | M | 12 mo | steady | none |
| ts-yarn-lib | Yarn 4 | TS library, tsc + node:test | S | 6 mo | reset | semver-lie-caught |
| js-npm-next-app | npm | Next.js app, build | L | 18 mo | steady | none |
| js-npm-workspaces | npm workspaces | 3 packages | M | 6 mo | reset | too-new-release |
| js-npm-canary | npm | small service, weak tests | S | 6 mo | reset | canary-postinstall, semver-lie-uncaught |
| py-uv-fastapi | uv | FastAPI + httpx + pydantic, pytest | S | 6 mo | reset | none |
| py-poetry-cli | Poetry | click + rich + requests, pytest | M | 12 mo | steady | none |
| py-pipcompile-flask | pip-compile | Flask, pytest | S | 6 mo | reset | none |
| py-pipenv-django | Pipenv | Django, manage.py test | M | 12 mo | steady | none |
| ex-mix-plug | Mix | Plug + Jason, mix test | S | 6 mo | reset | none |
| ex-mix-phoenix | Mix | minimal Phoenix, mix test | M | 12 mo | steady | none |

### 3. Mock registry (in-job, free)

`registry/packages/` holds planted `@pg/*` packages (see `catalog/scenarios.json`).
A fleet repo that uses them gets a `setup-script` that starts Verdaccio in Docker on
`localhost:4873`, builds its storage from the planted packages with `time` values
relative to "now" (for example "published 2 hours ago"), and points the `@pg` scope
at it. Its `ci.yml` does the same so bot PRs can be tested. Known Bridge gap to record,
not hide: the cooldown check only queries registry.npmjs.org, so planted packages show
as unverified. Fixing that (query the configured registry with its auth) is a Phase 2
Bridge task and also matters for TravelPass's private registry.

The canary scenario sets fake honeytokens (`GH_TOKEN`, `GITHUB_TOKEN`,
`BRIDGE_API_TOKEN` = `pg-honeytoken-<run id>`) in the update job env. Any honeytoken
appearing in a canary report, log, artifact or PR body is a critical failure.

### 4. Orchestrator

- `pg-provision.yml`: create/update the data repo and every fleet repo from the
  catalog (idempotent; re-run is safe), set `FLEET_BOT_TOKEN` as an org secret, enable
  Actions and auto-merge on fleet repos.
- `pg-run.yml` (daily, staggered start, plus dispatch with `experiment_id`,
  `bridge_ref`, `as_of`, `fixtures`): reset `reset` fixtures (force-push `baseline`,
  close open Bridge PRs, delete `bridge/*` branches), then dispatch each fixture's
  `bridge.yml`, at most `config.concurrency` at a time.
- `pg-collect.yml` (hourly): for each finished run, download artifacts, read the PR
  and its CI conclusion, merge green PRs on `steady` fixtures, write run records.
- `pg-report.yml` (daily, plus weekly): run `score.mjs`, commit the report, and once a
  week attach a `raw-YYYY-Www.tar.zst` release asset with every artifact of the week.

### 5. Data

Data repo (in the fleet org, public), small and append-only:

```
records/runs.jsonl              # one run record per line (schema/run-record.schema.json)
records/fixtures.json           # current catalog snapshot
reports/daily/YYYY-MM-DD.md     # scorecard + notable runs
reports/weekly/YYYY-Www.md
scoreboard.json                 # latest aggregates
```

Raw files (reports, logs, canary reports, step summaries) stay in Actions artifacts
for 30 days and in the weekly release asset after that. `pull-data.mjs` downloads
both to a local folder for agents.

Classify every run that did not end as expected into one failure category:
`install`, `registry-auth`, `network`, `peer-conflict`, `engine`, `checks-new-failure`,
`checks-flaky`, `cooldown`, `audit`, `timeout`, `workflow-config`, `unsupported`,
`bridge-crash`, `publish`, `honeytoken-leak`, `unknown`. Rules first; keep the raw
excerpt so an agent can re-classify `unknown`.

### 6. Scorecard and report

Scripts compute every number; agents never do the arithmetic. `score.mjs` writes
`scoreboard.json` (machine-readable, stable keys) and a markdown report: runs by
outcome, expected-vs-actual matrix per planted case, PR CI pass rate, timing
(p50/p95 per job and per Bridge phase, by ecosystem and size), new or growing failure
categories, changes since the previous report, and links to the 5 most interesting
runs. Compare against the scorecard targets above.

### 7. Notifications

Connor should hear about surprises, not routine. Add an optional `SLACK_WEBHOOK_URL`
secret on `bridge-cli` (skip notifications when it is absent):

- Daily, only if something is unexpected: mismatches, new failure categories, any
  honeytoken leak (always, immediately), or a cycle that did not complete.
- Weekly digest: the scorecard against targets and what changed.

### Phase 1 is done when

- Provisioning creates all 12 fixtures and the data repo from an empty org, and is
  idempotent.
- Three consecutive daily cycles run with no human action: dispatch, runs, collection,
  reports.
- At least 95% of runs have a complete record (report, logs, timing, PR state).
- Every planted case in the first 12 fixtures has at least one recorded outcome.
- `npm test` still passes; new code has tests; the corpus still passes.
- `docs/proving-ground/README.md` explains how to add a fixture, run an experiment
  against a branch, and pull the data.
- `pg-run.yml` can run the whole fleet against any `bridge-cli` branch and
  `score.mjs --compare <experimentA> <experimentB>` prints the scorecard difference
  (needed by the improvement loop in Phase 2).

## Phase 2

- Grow to ~30 synthetic fixtures (size up to 3,000+ locked packages, flaky tests,
  native modules, engine bumps, private-package auth, already-failing baselines,
  mixed JS + Python repos) and add `catalog/snapshots.json` with ~20 permissively
  licensed open-source apps whose tests run without external services (import at a
  commit 6-18 months old; replace their CI with a generated `ci.yml`).
- Time-machine experiments: `pg-run.yml` input to replay N weekly steps per fixture.
- Ruby gap fixtures (2).
- Switch publish to the Bridge GitHub App through the console broker; add the
  proving-ground workflow ref to the console's `BRIDGE_TRUSTED_WORKFLOWS`.
- Bridge fix: cooldown check honors configured and scoped registries with auth.
- Analysis loop: a weekly agent reads `AGENTS.md` + the scoreboard and opens issues
  in `cmccoy02/bridge-cli` labeled `proving-ground`, one finding per issue, each citing
  run IDs and raw evidence. (Connor will run this as a Claude scheduled task; build
  only what it needs: `pull-data.mjs`, stable scoreboard keys, `AGENTS.md`.)
- Improvement loop, see below.

## Improvement loop (Phase 2)

Goal: an issue labeled `agent-ready` becomes a pull request whose effect on the whole
fleet is measured before anyone merges it.

1. A coding agent (Claude Code) picks an `agent-ready` issue, writes the fix plus a
   test, and a planted case or corpus fixture that reproduces the problem, then opens
   a PR on `bridge-cli` that references the issue.
2. A workflow `pg-pr-eval.yml` (triggered by a `fleet-eval` label on a PR from this
   repository, never from forks) runs the full fleet with `bridge_ref` set to the PR
   branch, waits for collection, runs `score.mjs --compare <main baseline> <PR run>`
   and posts the before/after scorecard as a PR comment.
3. Merge rule, enforced by the comment and by review: the targeted metric improves and
   no other metric regresses beyond noise (define noise from repeated runs of `main`).
4. Connor approves every merge. Anything touching `src/commands/publish.js`,
   `src/core/handoff.js`, `src/core/executor.js`, `src/core/cooldown.js`, `src/core/cloud.js`,
   `action.yml` or `.github/workflows/bridge.yml` also gets a second review
   (Codex or a fresh Claude session that did not write it). Add a `CODEOWNERS` entry
   for those paths.

Guardrails (the loop must not be able to game its own score):

- Fixing agents must not modify `proving-ground/catalog/**`, expected outcomes,
  `proving-ground/scripts/score.mjs`, or fleet repos. `pg-pr-eval.yml` fails the
  evaluation if a PR touches those paths; such changes go in separate, human-reviewed PRs.
- No special-casing fixture names, scopes or the `@pg` scope in Bridge code. Add a
  check that fails CI if `src/**` mentions fixture IDs.
- A PR may not weaken a safety gate (cooldown, audit, validation, publish checks) to
  improve a pass rate. If the agent believes a gate is wrong, it writes that up in the
  issue instead.

## Stop and ask Connor only for

Org settings, tokens or permissions you cannot set yourself; spending money; adding a
snapshot repo whose license is not permissive; or anything that would touch a
repository outside the fleet org and `bridge-cli`.
