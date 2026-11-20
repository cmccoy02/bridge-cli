# Reading proving ground data (for analysis agents)

You are analyzing how Bridge behaves across the fleet. Your output is findings that
someone can act on, each backed by run IDs and raw evidence. Do not change fleet
repositories or Bridge code during analysis.

## Get the data

```bash
npm run pg:pull -- --since 7d --out ~/bridge-pg-data
```

- `records/runs.jsonl`: one run record per line (`proving-ground/schema/run-record.schema.json`).
- `reports/`: daily and weekly scorecards already computed.
- `raw/<experimentId>/<fixtureId>/<runId>/`: the Bridge report (`bridge-report.v1.json`,
  `bridge-report.final.json`), operations log (`*.jsonl`), per-check logs, canary
  reports, the GitHub step summary and the workflow logs.
- `proving-ground/catalog/`: what each fixture is and what each planted case expects.

## What to look for

1. Mismatches: `match: false`. Group by `failure.category`, then by fixture and
   ecosystem. A category that is new this week, or grew, comes first.
2. Known misses: runs where `expected.knownMiss` is true. Is the miss rate changing?
3. `unknown` failures: read the raw logs and propose a category and a rule that
   would have classified it.
4. Time: p50/p95 of `timing.totalMs` and of each Bridge phase, by ecosystem and size.
   Name the slowest phase and the fixtures driving it.
5. PR quality: of PRs opened, how many passed the fixture's own CI (`pr.ciConclusion`)?
   For the ones that did not, was Bridge's own check list missing something CI runs?
6. Any `honeytokenLeaks > 0` is critical. Report it first, with the exact file and line.

## How to report

One finding per issue in `cmccoy02/bridge-cli`, label `proving-ground`:

- Title: the behavior, not the symptom ("pip-compile scope reinstalls with the wrong
  Python version"), plus the affected share ("7 of 9 runs").
- Evidence: run IDs, links to workflow runs, the 5-20 log lines that show it.
- Suspected cause with file and function in `src/`, if you can tell.
- Proposed fix and the planted case or corpus fixture that would lock it in.
- Add label `agent-ready` only when the fix is clear and testable without Connor.

Never paste tokens or anything that looks like one. If evidence contains one, say so
and stop.
