#!/usr/bin/env node
// Resets `reset`-mode fixtures to their baseline before a run: close open Bridge PRs,
// delete bridge/* branches, and force main back to the `baseline` tag. This is what
// makes a reset fixture measure "the first run a new customer sees" every time.
// Runs in pg-run with FLEET_TOKEN as GH_TOKEN.
//
// Usage: node reset.mjs [--fixtures a,b,c]

import { loadFixtures, loadFleetConfig } from './lib/fleet.mjs';
import { gh, ghJson, log } from './lib/exec.mjs';

async function resetFixture(org, fixture) {
  const repo = `${org}/${fixture.id}`;

  // Close open Bridge PRs and delete their branches.
  const prs = await ghJson(
    ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,headRefName', '--limit', '100'],
    { allowFailure: true }
  ).catch(() => []);

  for (const pr of prs || []) {
    if (String(pr.headRefName || '').startsWith('bridge/')) {
      await gh(['pr', 'close', String(pr.number), '--repo', repo, '--delete-branch'], { allowFailure: true });
    }
  }

  // Delete any remaining bridge/* branches.
  const branches = await ghJson(
    ['api', `repos/${repo}/branches`, '--paginate', '--jq', '[.[].name]'],
    { allowFailure: true }
  ).catch(() => []);

  for (const name of branches || []) {
    if (String(name).startsWith('bridge/')) {
      await gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${name}`], { allowFailure: true });
    }
  }

  // Force main back to the baseline tag.
  const baseline = await ghJson(
    ['api', `repos/${repo}/git/refs/tags/baseline`, '--jq', '.object.sha'],
    { allowFailure: true }
  ).catch(() => null);

  if (baseline) {
    const result = await gh(
      ['api', '-X', 'PATCH', `repos/${repo}/git/refs/heads/main`, '-f', `sha=${baseline}`, '-F', 'force=true'],
      { allowFailure: true }
    );
    log(`  ${fixture.id}: ${result.success ? 'reset to baseline' : `reset FAILED: ${(result.stderr || '').slice(0, 160)}`}`);
  } else {
    log(`  ${fixture.id}: no baseline tag; skipped`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let fixturesArg = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--fixtures') (fixturesArg = argv[i + 1]), (i += 1);
  }

  const config = await loadFleetConfig();
  const org = config.fleetOrg;
  const only = new Set(fixturesArg ? fixturesArg.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const fixtures = (await loadFixtures()).filter(
    (fixture) => fixture.mode === 'reset' && (only.size === 0 || only.has(fixture.id))
  );

  log(`resetting ${fixtures.length} reset-mode fixture(s)`);
  for (const fixture of fixtures) {
    await resetFixture(org, fixture);
  }
}

main().catch((error) => {
  process.stderr.write(`reset failed: ${error.message}\n`);
  process.exit(1);
});
