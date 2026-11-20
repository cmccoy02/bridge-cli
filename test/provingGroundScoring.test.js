import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRun } from '../proving-ground/scripts/lib/classify.mjs';
import { buildRunRecord, deriveActual, matchExpected } from '../proving-ground/scripts/lib/runRecord.mjs';
import { percentile, summarize, renderDaily } from '../proving-ground/scripts/lib/scorecard.mjs';
import { isoWeek } from '../proving-ground/scripts/score.mjs';

test('classifyRun: honeytoken leak wins over everything', () => {
  const result = classifyRun({ report: {}, status: 'pr_opened', honeytokenLeaks: 1 });
  assert.equal(result.category, 'honeytoken-leak');
});

test('classifyRun: a clean PR has no category', () => {
  assert.equal(classifyRun({ report: { run: { status: 'pushed' }, publish: { status: 'created' } }, status: 'pr_opened' }), null);
});

test('classifyRun: maps gates and log signals to categories', () => {
  const cooldown = classifyRun({ report: { outcome: { earlyExit: { code: 'cooldown_block' } } }, status: 'blocked' });
  assert.equal(cooldown.category, 'cooldown');

  const validation = classifyRun({ report: { outcome: { earlyExit: { code: 'validation_block' } } }, status: 'blocked' });
  assert.equal(validation.category, 'checks-new-failure');

  const peer = classifyRun({ report: { outcome: { failure: { message: 'npm ERR! ERESOLVE unable to resolve dependency tree (peer)' } } }, status: 'failed' });
  assert.equal(peer.category, 'peer-conflict');

  const network = classifyRun({ report: { outcome: { failure: { message: 'request failed: getaddrinfo ENOTFOUND registry' } } }, status: 'failed' });
  assert.equal(network.category, 'network');

  const unknown = classifyRun({ report: { outcome: { failure: { message: 'something odd' } } }, status: 'failed' });
  assert.equal(unknown.category, 'unknown');
});

test('deriveActual reads publish status and gate', () => {
  assert.deepEqual(deriveActual(null), { status: 'no_report', gate: null, message: null });
  assert.equal(deriveActual({ run: { status: 'pushed' }, publish: { status: 'created' } }).status, 'pr_opened');
  assert.equal(deriveActual({ run: { status: 'up_to_date' } }).status, 'up_to_date');

  const blocked = deriveActual({ run: { status: 'failed' }, outcome: { earlyExit: { code: 'cooldown_block' } } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.gate, 'cooldown_block');
});

test('matchExpected: a PR that avoided the fresh version still matches the cooldown case', () => {
  const expected = { status: ['pr_opened', 'up_to_date', 'blocked'], gate: 'cooldown_block', mustNotContain: ['@pg/fresh@2.0.1'] };

  // Native cooldown picked the old version: a PR with no gate, nothing forbidden.
  assert.equal(matchExpected(expected, { status: 'pr_opened', gate: null }, { forbiddenHit: false }), true);
  // The gate blocked it: a block with the right gate.
  assert.equal(matchExpected(expected, { status: 'blocked', gate: 'cooldown_block' }), true);
  // A PR that shipped the forbidden version is a miss.
  assert.equal(matchExpected(expected, { status: 'pr_opened', gate: null }, { forbiddenHit: true }), false);
});

test('matchExpected: honeytoken expectation must hold', () => {
  const expected = { status: ['pr_opened'], gate: null, honeytokenLeaks: 0 };
  assert.equal(matchExpected(expected, { status: 'pr_opened', gate: null }, { honeytokenLeaks: 0 }), true);
  assert.equal(matchExpected(expected, { status: 'pr_opened', gate: null }, { honeytokenLeaks: 2 }), false);
});

test('buildRunRecord assembles a schema-shaped record and classifies a mismatch', () => {
  const fixture = {
    id: 'js-npm-workspaces',
    tier: 'synthetic',
    ecosystem: 'javascript',
    manager: 'npm',
    size: 'M',
    mode: 'reset',
    scenarios: ['too-new-release']
  };
  const expected = { status: ['pr_opened', 'up_to_date', 'blocked'], gate: 'cooldown_block', mustNotContain: ['@pg/fresh@2.0.1'] };
  const report = {
    run: { id: 'patch-123', status: 'failed', bridgeVersion: '0.1.0' },
    outcome: { earlyExit: { code: 'cooldown_block' }, dependencySummary: { directChanged: 1, transitiveChanged: 3, byBump: {} } }
  };

  const record = buildRunRecord({
    fixture,
    expected,
    report,
    workflow: { runUrl: 'https://x/run/1', conclusion: 'success', artifacts: ['bridge-handoff'], timing: { totalMs: 120000 } },
    experimentId: 'daily-2026-11-20',
    collectedAt: '2026-11-20T10:00:00.000Z'
  });

  assert.equal(record.recordVersion, 1);
  assert.equal(record.runId, 'patch-123');
  assert.equal(record.actual.status, 'blocked');
  assert.equal(record.actual.gate, 'cooldown_block');
  assert.equal(record.match, true);
  assert.equal(record.failure, null);
  assert.equal(record.changes.transitive, 3);
  assert.equal(record.timing.totalMs, 120000);
});

test('percentile and summarize produce a scoreboard and markdown', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([], 95), null);

  const records = [
    { fixtureId: 'a', ecosystem: 'javascript', size: 'S', scenarios: ['clean-drift'], match: true, actual: { status: 'pr_opened' }, honeytokenLeaks: 0, timing: { totalMs: 60000, phases: {} }, pr: { ciConclusion: 'success' }, workflow: {} },
    { fixtureId: 'b', ecosystem: 'python', size: 'M', scenarios: ['too-new-release'], match: false, actual: { status: 'failed' }, failure: { category: 'network' }, honeytokenLeaks: 0, timing: { totalMs: 120000, phases: {} }, workflow: {} }
  ];

  const score = summarize(records, { generatedAt: '2026-11-20' });
  assert.equal(score.total, 2);
  assert.equal(score.matchRate, 0.5);
  assert.equal(score.failureCategories.network, 1);
  assert.equal(score.scenarioMatrix['too-new-release'].total, 1);

  const md = renderDaily(records, { date: '2026-11-20', scoreboard: score });
  assert.match(md, /Proving ground - 2026-11-20/);
  assert.match(md, /Planted cases/);
});

test('isoWeek formats an ISO week label', () => {
  // 2026-11-20 is a Friday in ISO week 47.
  assert.equal(isoWeek(new Date('2026-11-20T00:00:00Z')), '2026-W47');
  // 2026-01-01 is a Thursday, ISO week 1.
  assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')), '2026-W01');
});
