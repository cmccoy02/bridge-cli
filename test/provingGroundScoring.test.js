import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyRun } from '../proving-ground/scripts/lib/classify.mjs';
import { buildRunRecord, deriveActual, matchExpected } from '../proving-ground/scripts/lib/runRecord.mjs';
import { diffScoreboards, percentile, renderComparison, summarize, renderDaily } from '../proving-ground/scripts/lib/scorecard.mjs';
import { buildDailyAlert, buildLeakAlert, buildWeeklyDigest, postSlack } from '../proving-ground/scripts/lib/notify.mjs';
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

test('diffScoreboards reports deltas and new/grown categories', () => {
  const previous = { matchRate: 0.9, prCiPassRate: 0.5, honeytokenLeaks: 0, failureCategories: { network: 1 } };
  const current = { matchRate: 0.8, prCiPassRate: 0.6, honeytokenLeaks: 0, failureCategories: { network: 3, cooldown: 2 } };
  const diff = diffScoreboards(current, previous);
  assert.ok(Math.abs(diff.matchRateDelta - -0.1) < 1e-9);
  assert.deepEqual(diff.newCategories, ['cooldown']);
  assert.deepEqual(diff.grownCategories, ['network']);
});

test('renderComparison prints a before/after scorecard', () => {
  const a = summarize([{ match: true, actual: { status: 'pr_opened' }, ecosystem: 'js', size: 'S', scenarios: [], honeytokenLeaks: 0, timing: { phases: {} }, workflow: {} }]);
  const b = summarize([{ match: false, actual: { status: 'failed' }, failure: { category: 'network' }, ecosystem: 'js', size: 'S', scenarios: [], honeytokenLeaks: 0, timing: { phases: {} }, workflow: {} }]);
  const md = renderComparison('main', a, 'pr-branch', b);
  assert.match(md, /Comparison: main -> pr-branch/);
  assert.match(md, /Match rate/);
});

test('buildDailyAlert stays quiet on a clean day and fires on surprises', () => {
  const scoreboard = { matchRate: 1, honeytokenLeaks: 0, failureCategories: {} };
  const clean = buildDailyAlert({ scoreboard, dayRecords: [{ match: true, honeytokenLeaks: 0 }], date: '2026-11-20' });
  assert.equal(clean, null);

  const leaky = buildDailyAlert({
    scoreboard: { matchRate: 0.5, honeytokenLeaks: 1, failureCategories: {} },
    dayRecords: [{ fixtureId: 'js-npm-canary', match: false, honeytokenLeaks: 1, actual: { status: 'pr_opened' } }],
    date: '2026-11-20'
  });
  assert.ok(leaky);
  assert.match(leaky.text, /HONEYTOKEN LEAK/);
});

test('buildLeakAlert and buildWeeklyDigest format messages', () => {
  assert.equal(buildLeakAlert([]), null);
  const leak = buildLeakAlert([{ fixtureId: 'x', runId: 'r1', honeytokenLeaks: 2, workflow: { runUrl: 'u' } }]);
  assert.match(leak.text, /honeytoken leak/i);

  const digest = buildWeeklyDigest({ total: 10, matchRate: 0.9, prCiPassRate: 0.7, honeytokenLeaks: 0, failureCategories: { network: 2 }, targets: {} }, { week: '2026-W47' });
  assert.match(digest.text, /weekly digest 2026-W47/);
});

test('postSlack is a no-op without a webhook and posts with one', async () => {
  assert.deepEqual(await postSlack('', 'hi'), { status: 'skipped' });

  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return { ok: true, status: 200 };
  };
  const result = await postSlack('https://hooks.example/abc', 'hello', { fetchImpl });
  assert.equal(result.status, 'sent');
  assert.equal(captured.url, 'https://hooks.example/abc');
  assert.equal(captured.body.text, 'hello');
});
