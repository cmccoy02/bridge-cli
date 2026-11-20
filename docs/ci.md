# Bridge in GitHub Actions

## The short version

```yaml
jobs:
  bridge:
    uses: cmccoy02/bridge-cli/.github/workflows/bridge.yml@main
    permissions:
      contents: read
      id-token: write
    with:
      api-url: https://YOUR-BRIDGE-CONSOLE.vercel.app
```

Install the Bridge GitHub App on the repository. No repository secrets are needed.

## Why two jobs

Updating dependencies means running code you did not write: install scripts,
`prepare` hooks, test suites that import the new versions. If that code can reach
a credential that pushes to the repository, one malicious release can push to
your default branch or tamper with workflows.

Bridge splits the run so that never happens:

| Job | Runs package code | Credentials | Output |
| --- | --- | --- | --- |
| `update` | Yes (install, update, your checks) | `contents: read` only. No OIDC, no bot token | Handoff bundle: changed manifests/lockfiles, PR text, run report |
| `publish` | No | `id-token: write` → short-lived GitHub App token from the Bridge console | Branch `bridge/...` and the pull request |

Inside the `update` job, every command that runs package code also has
`GH_TOKEN`, `GITHUB_TOKEN`, `ACTIONS_*` tokens and `BRIDGE_*` secrets removed
from its environment.

The `publish` job treats the bundle as untrusted. It:

- accepts only dependency manifests and lockfiles (no `.github/`, no source,
  no `node_modules`, no path traversal, no symlinks), and checks each file's
  SHA-256;
- requires the bundle's base commit to already be on the default branch, so a
  compromised update job cannot slip other commits into the pull request;
- rejects any `package.json` change outside `dependencies`,
  `devDependencies`, `optionalDependencies`, `peerDependencies`, `overrides`,
  `resolutions` and `pnpm.overrides` (so no new `scripts`), any new dependency,
  and any spec that installs from outside the registry (git, URLs, `file:`);
- rejects lockfiles or manifests that download from a host the old file never
  used, `requirements.txt` lines that add index options or URLs, and any change
  to files dependency updates never edit (`mix.exs`, `pyproject.toml`, `Pipfile`,
  `requirements.in`, `pnpm-workspace.yaml`);
- only pushes branches that start with `bridge/`, never the default branch,
  and uses `--force-with-lease` when refreshing its own PR;
- commits with hooks disabled, as the Bridge bot;
- refuses a bundle built for a different repository.

## How the token broker works

1. The `publish` job asks GitHub for an OIDC token (audience: the console URL).
2. The Bridge console verifies the token against GitHub's signing keys, checks
   that it came from Bridge's reusable workflow (`job_workflow_ref`), and that
   the Bridge GitHub App is installed on that repository.
3. The console returns an installation token limited to that one repository
   with `contents: write` and `pull_requests: write`. It expires within an hour.
4. Bridge pushes, opens the PR, and uploads the run report to the console.

Pull requests opened with a GitHub App token trigger your normal CI, unlike
PRs opened with the workflow's own `GITHUB_TOKEN`.

## Without the GitHub App

Pass a token with `contents: write` and `pull-requests: write` as the
`bridge-github-token` secret. Bridge uses it only in the `publish` job.

## Private registries

```yaml
    with:
      registry-url: https://npm.pkg.github.com
      registry-scope: '@your-org'
    secrets:
      npm-token: ${{ secrets.NPM_TOKEN }}
```

The token is exposed to the `update` job as `NODE_AUTH_TOKEN`/`NPM_TOKEN`, which
installs need. It is never given to the `publish` job.

## Known gaps (v0)

- The PR description text comes from the `update` job. File contents are
  validated; the prose is not. Next step: rebuild the package table in
  `publish` by diffing the lockfiles itself.
- `npm-version: '11'` is needed on Node 22 runners for npm's native cooldown.
  Without it Bridge still verifies publish dates after the update, but blocks
  instead of picking an older version.
- The reusable workflow pins `cmccoy02/bridge-cli@main`. Cut a `v0` tag and pin
  to it before outside teams use it.
