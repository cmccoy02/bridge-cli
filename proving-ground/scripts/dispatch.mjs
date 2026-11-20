#!/usr/bin/env node
// Dispatches each fixture's Bridge workflow (workflow_dispatch), at most
// config.concurrency at a time. The fixtures' workflows have no cron, so every run is
// a deliberate, countable dispatch. Runs in pg-run with FLEET_TOKEN as GH_TOKEN.
//
// Usage: node dispatch.mjs [--experiment-id <id>] [--bridge-ref <ref>] [--as-of <date>]
//                          [--fixtures a,b,c]

import { loadFixtures, loadFleetConfig } from './lib/fleet.mjs';
import { gh, log } from './lib/exec.mjs';

function today() {
  // A normal Node process (not a workflow DSL script), so Date is available.
  return new Date().toISOString().slice(0, 10);
}

async function pool(items, concurrency, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, run));
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { experimentId: '', bridgeRef: '', asOf: '', fixtures: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--experiment-id') (opts.experimentId = argv[i + 1]), (i += 1);
    else if (argv[i] === '--bridge-ref') (opts.bridgeRef = argv[i + 1]), (i += 1);
    else if (argv[i] === '--as-of') (opts.asOf = argv[i + 1]), (i += 1);
    else if (argv[i] === '--fixtures') (opts.fixtures = argv[i + 1]), (i += 1);
  }

  const config = await loadFleetConfig();
  const org = config.fleetOrg;
  const experimentId = opts.experimentId || `daily-${today()}`;
  const only = new Set(opts.fixtures ? opts.fixtures.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const fixtures = (await loadFixtures()).filter((fixture) => only.size === 0 || only.has(fixture.id));

  log(`dispatching ${fixtures.length} fixture(s) as experiment ${experimentId} (concurrency ${config.concurrency})`);

  await pool(fixtures, config.concurrency || 5, async (fixture) => {
    const args = ['workflow', 'run', 'bridge.yml', '--repo', `${org}/${fixture.id}`,
      '-f', `experiment_id=${experimentId}`,
      '-f', `bridge_ref=${opts.bridgeRef}`,
      '-f', `as_of=${opts.asOf}`];
    const result = await gh(args, { allowFailure: true });
    log(`  ${result.success ? 'dispatched' : 'FAILED  '} ${fixture.id}${result.success ? '' : `: ${(result.stderr || '').slice(0, 160)}`}`);
  });
}

main().catch((error) => {
  process.stderr.write(`dispatch failed: ${error.message}\n`);
  process.exit(1);
});
