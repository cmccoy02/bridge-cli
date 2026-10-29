import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  renderCrontab,
  renderLaunchdPlist,
  scheduleInstallCommand
} from '../src/commands/schedule.js';
import { buildWrapperArgs } from '../src/core/batchRunner.js';
import {
  buildDailySummaryModel,
  formatAfterScriptLine,
  formatDailySummary,
  oneLineFailureReason,
  prLinkLabel,
  rebuildDailySummary,
  repoEntryFromReport
} from '../src/core/dailySummary.js';
import { buildNotifyPayload } from '../src/core/notifyLocal.js';
import { applyEnvOverrides, DEFAULT_SETTINGS } from '../src/core/bridgeSettings.js';
import { buildRunSignal } from '../src/core/runSignal.js';

test('formatDailySummary lists repos, after-scripts, PR new vs updated, and failures', () => {
  const model = buildDailySummaryModel({
    dateStamp: '2026-10-23',
    batch: {
      id: 'batch-1',
      performance: {
        wallMs: 8100,
        runWallMs: 12400,
        peakRssBytes: 210 * 1024 * 1024,
        cpuUserMs: 4200,
        cpuSystemMs: 600
      }
    },
    repos: [
      {
        repo: 'travelpassbook.com',
        status: 'pushed',
        durationMs: 6200,
        packages: '15 direct, 144 transitive',
        packagesUpdated: 159,
        afterScripts: 'npm run typecheck pass 4.2s',
        pr: 'updated https://github.com/cmccoy02/travelpassbook.com/pull/16'
      },
      {
        repo: 'payments-api',
        status: 'failed',
        durationMs: 2100,
        packages: 'none',
        packagesUpdated: 0,
        afterScripts: 'npm test fail 1.1s (new)',
        pr: '—',
        failureReason: 'after-script npm test new failure'
      }
    ]
  });
  const text = formatDailySummary(model);

  assert.match(text, /Bridge daily summary  2026-10-23/);
  assert.match(text, /Repos: travelpassbook.com, payments-api/);
  assert.match(text, /Packages updated: 159/);
  assert.match(text, /npm run typecheck pass 4\.2s/);
  assert.match(text, /PR: updated https:\/\/github.com\/cmccoy02\/travelpassbook.com\/pull\/16/);
  assert.match(text, /PR: —/);
  assert.match(text, /Failure: after-script npm test new failure/);
  assert.match(text, /Peak RSS:/);
});

test('repoEntryFromReport distinguishes created vs reused PRs', () => {
  const created = repoEntryFromReport({
    run: { id: 'a', status: 'pushed', durationMs: 10, startedAt: '2026-10-23T16:29:40.000Z' },
    target: { repository: 'app' },
    outcome: {
      dependencySummary: { totalChanged: 2, directChanged: 1, transitiveChanged: 1 },
      scriptSummary: {
        scripts: [{ name: 'npm test', result: 'pass', durationMs: 40 }]
      },
      pullRequest: { status: 'created', url: 'https://example.test/pr/1' }
    }
  });
  const reused = repoEntryFromReport({
    run: { id: 'b', status: 'pushed', durationMs: 11 },
    target: { repository: 'app' },
    outcome: {
      dependencySummary: { totalChanged: 0, directChanged: 0, transitiveChanged: 0 },
      scriptSummary: { scripts: [] },
      pullRequest: { status: 'existing', url: 'https://example.test/pr/1', reused: true }
    }
  });

  assert.equal(created.pr, 'new https://example.test/pr/1');
  assert.equal(reused.pr, 'reused https://example.test/pr/1');
  assert.equal(prLinkLabel({ status: 'updated', url: 'https://example.test/pr/2' }), 'updated https://example.test/pr/2');
});

test('oneLineFailureReason prefers the first new after-script when no message', () => {
  assert.equal(
    oneLineFailureReason({
      run: { status: 'failed' },
      outcome: {
        scriptSummary: {
          scripts: [{ name: 'npm test', result: 'fail', failureKind: 'new' }]
        }
      }
    }),
    'after-script npm test new failure'
  );
});

test('formatAfterScriptLine includes duration and pass/fail', () => {
  assert.equal(
    formatAfterScriptLine({
      scripts: [
        { name: 'npm run typecheck', result: 'pass', durationMs: 4200 },
        { name: 'npm test', result: 'fail', durationMs: 1100, failureKind: 'new' }
      ]
    }),
    'npm run typecheck pass 4.2s, npm test fail 1.1s (new)'
  );
});

test('rebuildDailySummary writes LATEST.md from today\'s reports', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-summary-home-'));
  const previous = process.env.BRIDGE_HOME;
  process.env.BRIDGE_HOME = bridgeHome;
  t.after(async () => {
    if (previous === undefined) {
      delete process.env.BRIDGE_HOME;
    } else {
      process.env.BRIDGE_HOME = previous;
    }
    await fs.rm(bridgeHome, { recursive: true, force: true });
  });

  const runDir = path.join(bridgeHome, 'runs', 'patch-1');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'bridge-report.v1.json'),
    `${JSON.stringify({
      run: {
        id: 'patch-1',
        status: 'pushed',
        startedAt: '2026-10-23T16:29:40.000Z',
        durationMs: 1000
      },
      generatedAt: '2026-10-23T16:29:40.000Z',
      target: { repository: 'travelpassbook.com' },
      outcome: {
        dependencySummary: { totalChanged: 2, directChanged: 2, transitiveChanged: 0 },
        scriptSummary: {
          scripts: [{ name: 'npm run typecheck', result: 'pass', durationMs: 400 }]
        },
        pullRequest: { status: 'created', url: 'https://example.test/pr/16' }
      }
    })}\n`,
    'utf8'
  );

  const result = await rebuildDailySummary({
    dateStamp: '2026-10-23',
    bridgeHome
  });
  assert.match(result.text, /travelpassbook.com/);
  assert.match(result.text, /new https:\/\/example.test\/pr\/16/);
  const latest = await fs.readFile(path.join(bridgeHome, 'schedule', 'LATEST.md'), 'utf8');
  assert.equal(latest, result.text);
});

async function writeSummaryReport(bridgeHome, { id, batchId, startedAt, repo, totalChanged }) {
  const runDir = path.join(bridgeHome, 'runs', id);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'bridge-report.v1.json'),
    `${JSON.stringify({
      run: {
        id,
        ...(batchId ? { batchId } : {}),
        status: 'pushed',
        startedAt,
        finishedAt: startedAt,
        durationMs: 1000
      },
      generatedAt: startedAt,
      target: { repository: repo },
      outcome: {
        dependencySummary: { totalChanged, directChanged: totalChanged, transitiveChanged: 0 },
        scriptSummary: { scripts: [] },
        pullRequest: null
      }
    })}\n`,
    'utf8'
  );
}

test('LATEST.md totals only the latest batch; the dated file keeps the whole day', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-summary-batches-'));
  t.after(async () => {
    await fs.rm(bridgeHome, { recursive: true, force: true });
  });

  await writeSummaryReport(bridgeHome, {
    id: 'patch-a1',
    batchId: 'batch-a',
    startedAt: '2026-10-23T13:30:00.000Z',
    repo: 'app',
    totalChanged: 100
  });
  await writeSummaryReport(bridgeHome, {
    id: 'patch-a2',
    batchId: 'batch-a',
    startedAt: '2026-10-23T13:30:05.000Z',
    repo: 'api',
    totalChanged: 20
  });
  await writeSummaryReport(bridgeHome, {
    id: 'patch-b1',
    batchId: 'batch-b',
    startedAt: '2026-10-23T19:30:00.000Z',
    repo: 'app',
    totalChanged: 3
  });
  // A run from the second batch whose report predates batch ids (older Bridge binary).
  await writeSummaryReport(bridgeHome, {
    id: 'patch-b2',
    startedAt: '2026-10-23T19:30:04.000Z',
    repo: 'api',
    totalChanged: 4
  });

  const first = await rebuildDailySummary({
    dateStamp: '2026-10-23',
    bridgeHome,
    batch: { id: 'batch-a' }
  });
  assert.equal(first.model.totals.packagesUpdated, 120);
  assert.match(first.text, /Batch: batch-a/);

  const second = await rebuildDailySummary({
    dateStamp: '2026-10-23',
    bridgeHome,
    batch: { id: 'batch-b' },
    batchRunIds: ['patch-b2']
  });
  assert.equal(second.model.totals.packagesUpdated, 7);
  assert.deepEqual(
    second.model.repos.map((entry) => entry.runId),
    ['patch-b1', 'patch-b2']
  );

  const latest = await fs.readFile(path.join(bridgeHome, 'schedule', 'LATEST.md'), 'utf8');
  assert.equal(latest, second.text);
  assert.match(latest, /Packages updated: 7/);

  const daily = await fs.readFile(
    path.join(bridgeHome, 'schedule', 'summaries', 'daily', '2026-10-23.md'),
    'utf8'
  );
  assert.equal(daily, second.dailyText);
  assert.match(daily, /Packages updated: 127/);
  assert.doesNotMatch(daily, /Batch:/);
});

test('without a batch, LATEST.md follows the most recent run and its batch', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-summary-implicit-'));
  t.after(async () => {
    await fs.rm(bridgeHome, { recursive: true, force: true });
  });

  await writeSummaryReport(bridgeHome, {
    id: 'patch-a1',
    batchId: 'batch-a',
    startedAt: '2026-10-23T13:30:00.000Z',
    repo: 'app',
    totalChanged: 5
  });
  await writeSummaryReport(bridgeHome, {
    id: 'patch-a2',
    batchId: 'batch-a',
    startedAt: '2026-10-23T13:30:05.000Z',
    repo: 'api',
    totalChanged: 6
  });

  const inBatch = await rebuildDailySummary({ dateStamp: '2026-10-23', bridgeHome });
  assert.equal(inBatch.model.totals.packagesUpdated, 11);
  assert.match(inBatch.text, /Batch: batch-a/);

  await writeSummaryReport(bridgeHome, {
    id: 'patch-manual',
    startedAt: '2026-10-23T20:00:00.000Z',
    repo: 'app',
    totalChanged: 2
  });

  const standalone = await rebuildDailySummary({ dateStamp: '2026-10-23', bridgeHome });
  assert.deepEqual(
    standalone.model.repos.map((entry) => entry.runId),
    ['patch-manual']
  );
  assert.equal(standalone.model.totals.packagesUpdated, 2);
  assert.doesNotMatch(standalone.text, /Batch:/);
  assert.match(standalone.dailyText, /Packages updated: 13/);
});

test('run_signal / time-saved fields include duration, packages, scripts, outcome, PR', () => {
  const signal = buildRunSignal({
    run: { runId: 'patch-1', durationMs: 900 },
    status: 'pushed',
    repo: 'app',
    dependencySummary: { totalChanged: 3, directChanged: 1, transitiveChanged: 2 },
    scriptSummary: { totals: { scripts: 2, passed: 2, failed: 0 } },
    pullRequest: { status: 'created', url: 'https://example.test/pr/3' },
    performance: { durationMs: 900, peakRssBytes: 10, cpuUserMs: 4, cpuSystemMs: 1 }
  });

  assert.equal(signal.schemaVersion, 'bridge-time-saved.v1');
  assert.equal(signal.packagesUpdated, 3);
  assert.equal(signal.scriptsRun, 2);
  assert.equal(signal.outcome, 'pushed');
  assert.equal(signal.prAction, 'created');
  assert.equal(signal.prUrl, 'https://example.test/pr/3');
  assert.equal(signal.durationMs, 900);
});

test('settings env overrides retain age/count caps', () => {
  const settings = applyEnvOverrides(DEFAULT_SETTINGS, {
    BRIDGE_RETENTION_DAYS: '14',
    BRIDGE_RETENTION_MAX_RUNS: '40',
    BRIDGE_CONCURRENCY: '3',
    BRIDGE_NOTIFY: '1'
  });
  assert.equal(settings.retention.maxAgeDays, 14);
  assert.equal(settings.retention.maxRuns, 40);
  assert.equal(settings.concurrency, 3);
  assert.equal(settings.notify, true);
});

test('schedule install --print --runner cli embeds bridge schedule run', async () => {
  const plist = renderLaunchdPlist({
    runner: 'cli',
    repos: [{ repo: 'git@example.test:org/app.git' }],
    configPath: '/tmp/bridge.config.json',
    time: '07:30'
  });
  assert.match(plist, /schedule<\/string>\n    <string>run<\/string>/);
  assert.match(plist, /--skip-before-scripts|schedule/);
  assert.match(plist, /git@example.test:org\/app.git/);

  const cron = renderCrontab({
    runner: 'script',
    repos: [{ repo: '/tmp/app' }],
    configPath: '/tmp/bridge.config.json'
  });
  assert.match(cron, /bridge-daily\.sh/);
  assert.match(cron, /--repo \/tmp\/app/);
});

test('scheduled wrapper args keep before-scripts skipped by default', () => {
  const args = buildWrapperArgs({ repo: '/tmp/app' }, { skipBeforeScripts: true });
  assert.ok(args.includes('--skip-before-scripts'));
  assert.ok(!args.includes('--run-before-scripts'));
});

test('schedule install --print writes to stdout without touching LaunchAgents', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-schedule-home-'));
  const previousHome = process.env.BRIDGE_HOME;
  process.env.BRIDGE_HOME = home;
  t.after(() => {
    if (previousHome === undefined) {
      delete process.env.BRIDGE_HOME;
    } else {
      process.env.BRIDGE_HOME = previousHome;
    }
  });

  const ok = await scheduleInstallCommand({
    repo: ['git@example.test:org/app.git'],
    print: true,
    runner: 'cli',
    config: '/tmp/bridge.config.json'
  });
  assert.equal(ok, true);
});

test('docs include a captured daily summary sample', async () => {
  const text = await fs.readFile(
    new URL('../docs/daily-summary.sample.md', import.meta.url),
    'utf8'
  );
  assert.match(text, /Bridge daily summary/);
  assert.match(text, /PR: updated /);
  assert.match(text, /Failure:/);
  assert.match(text, /After-scripts:/);
});

test('notify payload stays short and names the repos', () => {
  const payload = buildNotifyPayload(
    'Bridge daily summary  2026-10-23\nRepos: app, other\napp  failed  1.0s\n  Failure: boom\n'
  );
  assert.match(payload.body, /Repos: app, other/);
});
