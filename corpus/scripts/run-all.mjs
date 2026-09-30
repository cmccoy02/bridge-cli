#!/usr/bin/env node

/**
 * Run Bridge patch (dry-run) against all corpus fixtures and generate a scoreboard.
 *
 * Usage:
 *   node corpus/scripts/run-all.mjs
 *   node corpus/scripts/run-all.mjs --verbose
 *   node corpus/scripts/run-all.mjs --fixture clean-outdated
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFixture } from './run-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.dirname(__dirname);
const FIXTURES_DIR = path.join(CORPUS_ROOT, 'fixtures');
const ARTIFACTS_DIR = path.join(CORPUS_ROOT, 'artifacts');

async function listFixtures() {
  const entries = await fs.readdir(FIXTURES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatStatus(result) {
  const icons = {
    patched: '✓',
    up_to_date: '○',
    failed: '✗'
  };
  return `${icons[result.status] || '?'} ${result.status}`;
}

async function runAllFixtures(options = {}) {
  const { verbose = false, fixtureFilter = null } = options;

  let fixtures = await listFixtures();
  if (fixtureFilter) {
    fixtures = fixtures.filter((f) => f === fixtureFilter);
    if (fixtures.length === 0) {
      throw new Error(`Fixture not found: ${fixtureFilter}`);
    }
  }

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Bridge Corpus Harness - Running All              ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Fixtures: ${fixtures.length.toString().padEnd(46)}║`);
  console.log(`║  Mode: dry-run                                             ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');

  const results = [];
  const startTime = Date.now();

  for (const fixture of fixtures) {
    try {
      const result = await runFixture(fixture, {
        verbose,
        saveArtifacts: true
      });
      results.push(result);
    } catch (err) {
      results.push({
        fixture,
        status: 'error',
        exitCode: 1,
        durationMs: 0,
        directUpdates: 0,
        transitiveUpdates: 0,
        hasBaselineNoise: false,
        hasNewFailures: false,
        error: err.message,
        timestamp: new Date().toISOString()
      });
    }
  }

  const totalDuration = Date.now() - startTime;

  const scoreboard = {
    schemaVersion: 'corpus-scoreboard.v1',
    generatedAt: new Date().toISOString(),
    totalDurationMs: totalDuration,
    summary: {
      total: results.length,
      patched: results.filter((r) => r.status === 'patched').length,
      upToDate: results.filter((r) => r.status === 'up_to_date').length,
      failed: results.filter((r) => r.status === 'failed').length,
      error: results.filter((r) => r.status === 'error').length
    },
    results
  };

  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
  const scoreboardPath = path.join(ARTIFACTS_DIR, 'scoreboard.json');
  await fs.writeFile(scoreboardPath, JSON.stringify(scoreboard, null, 2));

  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                      SCOREBOARD                            ║');
  console.log('╠════════════════════════════════════════════════════════════╣');

  for (const r of results) {
    const statusStr = formatStatus(r).padEnd(15);
    const durationStr = formatDuration(r.durationMs).padStart(8);
    const updatesStr =
      r.directUpdates > 0 || r.transitiveUpdates > 0
        ? `(${r.directUpdates}d/${r.transitiveUpdates}t)`
        : '';
    console.log(
      `║  ${r.fixture.padEnd(20)} ${statusStr} ${durationStr} ${updatesStr.padEnd(10)}║`
    );
  }

  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(
    `║  Total: ${scoreboard.summary.total}  Patched: ${scoreboard.summary.patched}  Up-to-date: ${scoreboard.summary.upToDate}  Failed: ${scoreboard.summary.failed}`.padEnd(
      61
    ) + '║'
  );
  console.log(
    `║  Duration: ${formatDuration(totalDuration)}`.padEnd(61) + '║'
  );
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nScoreboard saved: ${scoreboardPath}`);

  return scoreboard;
}

function parseArgs(args) {
  const options = {
    verbose: false,
    fixtureFilter: null
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verbose' || args[i] === '-v') {
      options.verbose = true;
    } else if (args[i] === '--fixture' || args[i] === '-f') {
      options.fixtureFilter = args[i + 1];
      i++;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  try {
    const scoreboard = await runAllFixtures(options);
    const failedCount =
      scoreboard.summary.failed + scoreboard.summary.error;
    process.exit(failedCount > 0 ? 1 : 0);
  } catch (err) {
    console.error(`[corpus] Fatal error: ${err.message}`);
    process.exit(1);
  }
}

main();
