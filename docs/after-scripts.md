# Recommended after scripts

`afterScripts` are the repo-native gates Bridge re-runs on the candidate tree.
Only **new** failures (exit code or error output not present on the committed
baseline) block push/PR. Pre-existing identical failures are reported as
`baseline` and do not block unless `blockOnBaselineFailures` is enabled.

Put the same commands CI uses. Success is always **exit code 0**. Bridge stores
the full redacted stdout/stderr for every script under
`~/.bridge/runs/<run-id>/scripts/` and prints a compact CI-style table at the
end of the run.

| Script | Typical command | Success means | CI log format |
| --- | --- | --- | --- |
| Lint | `npm run lint` | Exit 0. No rule violations. Warnings-as-errors if that is how CI is configured. | One finding per line, usually `file:line:col: message` (ESLint stylish/unix, Biome diagnostics). Avoid interactive or TTY-only color dumps. |
| Test | `npm test` | Exit 0. Every test passed. No skipped-as-failed suites. | TAP, node:test, Vitest, or Jest: suite summary plus failure diffs. Duration fields (`duration_ms`, `Start at HH:MM:SS`) are normalized before comparison. |
| Build | `npm run build` | Exit 0. The production compile finished and wrote its artifacts. | Bundler/compiler progress followed by error stacks (`ERROR in …`, `Module not found`). Keep the command non-watch (`--watch` never exits). |
| Typecheck | `npm run typecheck` | Exit 0. No type errors (`tsc --noEmit`, `vue-tsc`, and similar). | `tsc --pretty false` lines: `file(line,col): error TS####: message`. One diagnostic per line so new errors are obvious against the baseline. |
| Format check | `npm run format:check` | Exit 0. No files would be rewritten (`prettier --check`, `biome check`). | Checker lists dirty paths only (`Code style issues found in …`). Do not run a format-write command here — that would mutate the isolated tree. |

## What Bridge records

The compact table printed at the end of `bridge patch` (and written to
`bridge-summary.md` / `outcome.scriptSummary`) uses this CI log format:

```
After-script summary
Script         Result  Failure   Duration  Log
npm run lint   pass    —         1.2s      ~/.bridge/runs/<run-id>/scripts/afterscripts-root-01-npm-run-lint.log
npm run test   fail    new       4.8s      ~/.bridge/runs/<run-id>/scripts/afterscripts-root-02-npm-run-test.log
```

| Result / Failure | Meaning |
| --- | --- |
| `pass` / `—` | Exit 0. Does not block. |
| `fail` / `new` | New failure versus the committed baseline. Blocks push/PR. |
| `fail` / `baseline` | Same failure was already present before the update. Not blocking unless `blockOnBaselineFailures`. |
| `fail` / `unmeasured` | Command is in `afterScripts` only, so it had no baseline row. Blocks. |

Match `beforeScripts` to `afterScripts` (or use `--skip-before-scripts`) so every
command has a baseline measurement. Keep Visualizer / bundle analysis in
`bundleAnalysis`, not in this list.
