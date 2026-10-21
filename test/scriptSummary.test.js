import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildScriptSummary,
  buildScriptSummaryRows,
  classifyAfterScriptFailure,
  formatDurationMs,
  formatScriptSummaryMarkdown,
  formatScriptSummaryTable,
  slugifyScriptCommand,
  writeRunSummaryFile,
  writeScriptCommandLog
} from '../src/core/scriptSummary.js';

test('classifyAfterScriptFailure distinguishes new, baseline, and unmeasured', () => {
  const comparison = {
    newFailures: [
      { command: 'npm test', notMeasuredOnBaseline: false },
      { command: 'npm run lint:ci', notMeasuredOnBaseline: true }
    ],
    baselineFailures: [{ after: { command: 'npm run lint' } }]
  };

  assert.equal(classifyAfterScriptFailure('npm test', comparison), 'new');
  assert.equal(classifyAfterScriptFailure('npm run lint', comparison), 'baseline');
  assert.equal(
    classifyAfterScriptFailure('npm run lint:ci', comparison),
    'unmeasured'
  );
  assert.equal(classifyAfterScriptFailure('npm run build', comparison), null);
});

test('formatDurationMs matches the compact CI-style units', () => {
  assert.equal(formatDurationMs(12), '12ms');
  assert.equal(formatDurationMs(1500), '1.5s');
  assert.equal(formatDurationMs(61000), '1m 1.0s');
});

test('slugifyScriptCommand produces a stable filename fragment', () => {
  assert.equal(slugifyScriptCommand('npm run lint'), 'npm-run-lint');
  assert.equal(slugifyScriptCommand(''), 'script');
});

test('buildScriptSummaryRows and table include log paths and failure kinds', () => {
  const rows = buildScriptSummaryRows({
    scope: 'root',
    comparison: {
      newFailures: [{ command: 'npm test' }],
      baselineFailures: [{ after: { command: 'npm run lint' } }]
    },
    afterResults: [
      {
        command: 'npm run lint',
        success: false,
        durationMs: 1200,
        logPath: '/tmp/lint.log'
      },
      { command: 'npm test', success: false, durationMs: 40, logPath: '/tmp/test.log' },
      { command: 'npm run build', success: true, durationMs: 10, logPath: '/tmp/build.log' }
    ]
  });
  const summary = buildScriptSummary({ rows, afterScriptsRan: true });
  const table = formatScriptSummaryTable(summary);
  const markdown = formatScriptSummaryMarkdown(summary, {
    runId: 'patch-1',
    status: 'failed'
  });

  assert.equal(rows[0].failureKind, 'baseline');
  assert.equal(rows[1].failureKind, 'new');
  assert.equal(rows[2].result, 'pass');
  assert.equal(summary.totals.failed, 2);
  assert.equal(summary.totals.newFailures, 1);
  assert.match(table, /After-script summary/);
  assert.match(table, /npm run lint/);
  assert.match(table, /baseline/);
  assert.match(table, /\/tmp\/lint\.log/);
  assert.match(markdown, /# Bridge after-script summary/);
  assert.match(markdown, /\| `npm test` \| fail \| new \|/);
});

test('empty summary explains why no after-scripts ran', () => {
  const summary = buildScriptSummary({
    afterScriptsRan: false,
    earlyExit: 'lockfile_unchanged',
    rows: []
  });
  const table = formatScriptSummaryTable(summary);
  assert.match(table, /no after-scripts ran \(lockfile_unchanged\)/);
});

test('writeScriptCommandLog redacts secrets and writeRunSummaryFile persists markdown', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-summary-'));
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

  const logPath = await writeScriptCommandLog('run-1', {
    phase: 'afterScripts',
    scope: 'root',
    index: 0,
    result: {
      command: 'npm test',
      code: 1,
      success: false,
      durationMs: 9,
      stdout: 'ok',
      stderr: 'token=super-secret\n'
    }
  });
  const summaryPath = await writeRunSummaryFile(
    'run-1',
    buildScriptSummary({
      afterScriptsRan: true,
      rows: [
        {
          name: 'npm test',
          result: 'fail',
          failureKind: 'new',
          durationMs: 9,
          logPath
        }
      ]
    }),
    { status: 'failed' }
  );
  const log = await fs.readFile(logPath, 'utf8');
  const markdown = await fs.readFile(summaryPath, 'utf8');

  assert.match(log, /command: npm test/);
  assert.match(log, /\[redacted\]/);
  assert.doesNotMatch(log, /super-secret/);
  assert.match(markdown, /npm test/);
  assert.match(summaryPath, /bridge-summary\.md$/);
});

test('docs/after-scripts.md lists recommended after scripts and CI log format', async () => {
  const text = await fs.readFile(new URL('../docs/after-scripts.md', import.meta.url), 'utf8');

  assert.match(text, /CI log format/i);
  assert.match(text, /Success means/i);
  for (const name of ['Lint', 'Test', 'Build', 'Typecheck', 'Format check']) {
    assert.match(text, new RegExp(name, 'i'));
  }
  assert.match(text, /After-script summary/);
  assert.match(text, /fail\s*\/\s*`new`|`new`/);
});
