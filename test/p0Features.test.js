import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureScriptResults,
  compareScriptResults,
  createScriptDiffReport,
  evaluateScriptValidationGate,
  formatBaselineBlockNotice,
  formatBaselinePersistNotice,
  formatBeforeScriptsBaselineNotice,
  formatNewFailureBlockMessage,
  formatScriptDiffSummary,
  formatValidationGateReason,
  formatValidationPrLine
} from '../src/core/scriptDiff.js';
import {
  combineCommandStreams,
  extractFailingExcerpt,
  failureOutputChanged,
  newErrorLines,
  normalizeFailureText
} from '../src/core/commandOutput.js';
import {
  describeScriptLifecycleOrder,
  SCOPE_WORKFLOW_PHASE_ORDER
} from '../src/core/scriptLifecycle.js';
import {
  BLOCKING_SEVERITIES,
  compareAuditSnapshots,
  createAuditComparisonReport,
  formatAuditDelta,
  SEVERITIES
} from '../src/core/audit.js';
import {
  checkTransitiveMajorPolicy,
  DEFAULT_TRANSITIVE_MAJOR_POLICY,
  formatTransitiveMajorSummary,
  getTransitiveMajorUpdates,
  TRANSITIVE_MAJOR_POLICIES
} from '../src/core/lockfileDiff.js';
import {
  cleanupLocalConfigAfterSuccessfulPush,
  CONFIG_RETENTION_POLICIES,
  DEFAULT_CONFIG_RETENTION_POLICY
} from '../src/core/configLifecycle.js';

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-p0-'));

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  return tempDir;
}

test('scriptDiff: captures script results correctly', () => {
  const rawResults = [
    { command: 'npm run lint', success: true, code: 0, durationMs: 100 },
    { command: 'npm test', success: false, code: 1, stderr: 'error', durationMs: 200 }
  ];

  const captured = captureScriptResults(rawResults);

  assert.equal(captured.length, 2);
  assert.equal(captured[0].command, 'npm run lint');
  assert.equal(captured[0].success, true);
  assert.equal(captured[1].command, 'npm test');
  assert.equal(captured[1].success, false);
  assert.equal(captured[1].exitCode, 1);
});

test('scriptDiff: detects new failures vs baseline noise', () => {
  const beforeResults = captureScriptResults([
    { command: 'npm run lint', success: false, code: 1 },
    { command: 'npm test', success: true, code: 0 }
  ]);

  const afterResults = captureScriptResults([
    { command: 'npm run lint', success: false, code: 1 },
    { command: 'npm test', success: false, code: 1 }
  ]);

  const comparison = compareScriptResults(beforeResults, afterResults);

  assert.equal(comparison.beforeFailureCount, 1);
  assert.equal(comparison.afterFailureCount, 2);
  assert.equal(comparison.newFailureCount, 1);
  assert.equal(comparison.baselineFailureCount, 1);
  assert.equal(comparison.hasNewFailures, true);
  assert.equal(comparison.hasBaselineNoise, true);
  assert.equal(comparison.newFailures[0].command, 'npm test');
});

test('scriptDiff: detects resolved failures', () => {
  const beforeResults = captureScriptResults([
    { command: 'npm run lint', success: false, code: 1 },
    { command: 'npm test', success: false, code: 1 }
  ]);

  const afterResults = captureScriptResults([
    { command: 'npm run lint', success: true, code: 0 },
    { command: 'npm test', success: true, code: 0 }
  ]);

  const comparison = compareScriptResults(beforeResults, afterResults);

  assert.equal(comparison.newFailureCount, 0);
  assert.equal(comparison.baselineFailureCount, 0);
  assert.equal(comparison.resolvedCount, 2);
  assert.equal(comparison.hasNewFailures, false);
});

test('scriptDiff: creates correct report structure', () => {
  const beforeResults = captureScriptResults([
    { command: 'npm run lint', success: false, code: 1 }
  ]);

  const afterResults = captureScriptResults([
    { command: 'npm run lint', success: true, code: 0 },
    { command: 'npm test', success: false, code: 1 }
  ]);

  const report = createScriptDiffReport(beforeResults, afterResults);

  assert.equal(report.before.total, 1);
  assert.equal(report.before.failed, 1);
  assert.equal(report.after.total, 2);
  assert.equal(report.after.failed, 1);
  assert.equal(report.diff.hasNewFailures, true);
  assert.equal(report.diff.newFailures.length, 1);
  assert.equal(report.diff.resolved.length, 1);
});

test('scriptDiff: formats summary correctly', () => {
  const comparison = {
    newFailureCount: 2,
    baselineFailureCount: 1,
    resolvedCount: 1,
    hasNewFailures: true,
    hasBaselineNoise: true
  };

  const summary = formatScriptDiffSummary(comparison);

  assert.match(summary, /2 NEW failure/);
  assert.match(summary, /introduced by the update \(blocking\)/);
  assert.match(summary, /1 pre-existing baseline failure/);
  assert.match(summary, /already present before the update; not blocking/);
  assert.match(summary, /1 pre-existing failure\(s\) resolved/);
  assert.doesNotMatch(summary, /persist \(not blocking\)/);
});

test('audit: severity-aware comparison detects blocking increases', () => {
  const before = {
    parsed: true,
    counts: { info: 0, low: 1, moderate: 2, high: 1, critical: 0, total: 4 }
  };

  const after = {
    parsed: true,
    counts: { info: 0, low: 1, moderate: 2, high: 3, critical: 0, total: 6 }
  };

  const comparison = compareAuditSnapshots(before, after);

  assert.equal(comparison.comparable, true);
  assert.equal(comparison.regressed, true);
  assert.equal(comparison.blocked, true);
  assert.match(comparison.blockReason, /high \+2/);
  assert.equal(comparison.delta.high, 2);
});

test('audit: non-blocking severity increases only regress, do not block', () => {
  const before = {
    parsed: true,
    counts: { info: 0, low: 1, moderate: 2, high: 1, critical: 0, total: 4 }
  };

  const after = {
    parsed: true,
    counts: { info: 0, low: 3, moderate: 4, high: 1, critical: 0, total: 8 }
  };

  const comparison = compareAuditSnapshots(before, after);

  assert.equal(comparison.regressed, true);
  assert.equal(comparison.blocked, false);
  assert.equal(comparison.blockReason, '');
});

test('audit: custom blocking severities are respected', () => {
  const before = {
    parsed: true,
    counts: { info: 0, low: 1, moderate: 2, high: 1, critical: 0, total: 4 }
  };

  const after = {
    parsed: true,
    counts: { info: 0, low: 3, moderate: 4, high: 1, critical: 0, total: 8 }
  };

  const comparison = compareAuditSnapshots(before, after, {
    blockingSeverities: ['moderate', 'low']
  });

  assert.equal(comparison.blocked, true);
  assert.match(comparison.blockReason, /moderate \+2/);
});

test('audit: formats severity delta correctly', () => {
  const comparison = {
    comparable: true,
    delta: { info: 0, low: 1, moderate: -1, high: 2, critical: 0, total: 2 }
  };

  const formatted = formatAuditDelta(comparison);

  assert.match(formatted, /low: \+1/);
  assert.match(formatted, /moderate: -1/);
  assert.match(formatted, /high: \+2/);
  assert.match(formatted, /\+2 total/);
});

test('audit: creates comparison report', () => {
  const before = { counts: { total: 4, critical: 0, high: 1, moderate: 2, low: 1, info: 0 } };
  const after = { counts: { total: 3, critical: 0, high: 0, moderate: 2, low: 1, info: 0 } };
  const comparison = {
    comparable: true,
    regressed: false,
    blocked: false,
    blockReason: '',
    delta: { total: -1, critical: 0, high: -1, moderate: 0, low: 0, info: 0 }
  };

  const report = createAuditComparisonReport(before, after, comparison);

  assert.equal(report.comparable, true);
  assert.equal(report.blocked, false);
  assert.equal(report.delta.high, -1);
});

test('lockfileDiff: detects transitive major updates', () => {
  const deltas = [
    { name: 'pkg-a', kind: 'direct', bump: 'major', from: '1.0.0', to: '2.0.0' },
    { name: 'pkg-b', kind: 'transitive', bump: 'major', from: '3.0.0', to: '4.0.0' },
    { name: 'pkg-c', kind: 'transitive', bump: 'minor', from: '1.0.0', to: '1.1.0' }
  ];

  const transitiveMajors = getTransitiveMajorUpdates(deltas);

  assert.equal(transitiveMajors.length, 1);
  assert.equal(transitiveMajors[0].name, 'pkg-b');
});

test('lockfileDiff: transitive major policy block', () => {
  const deltas = [
    { name: 'pkg-b', kind: 'transitive', bump: 'major', from: '3.0.0', to: '4.0.0' }
  ];

  const result = checkTransitiveMajorPolicy(deltas, 'block');

  assert.equal(result.policy, 'block');
  assert.equal(result.transitiveMajorCount, 1);
  assert.equal(result.shouldBlock, true);
  assert.equal(result.shouldWarn, false);
  assert.match(result.message, /blocked/i);
});

test('lockfileDiff: transitive major policy warn', () => {
  const deltas = [
    { name: 'pkg-b', kind: 'transitive', bump: 'major', from: '3.0.0', to: '4.0.0' }
  ];

  const result = checkTransitiveMajorPolicy(deltas, 'warn');

  assert.equal(result.policy, 'warn');
  assert.equal(result.shouldBlock, false);
  assert.equal(result.shouldWarn, true);
  assert.match(result.message, /warning/i);
});

test('lockfileDiff: transitive major policy allow', () => {
  const deltas = [
    { name: 'pkg-b', kind: 'transitive', bump: 'major', from: '3.0.0', to: '4.0.0' }
  ];

  const result = checkTransitiveMajorPolicy(deltas, 'allow');

  assert.equal(result.policy, 'allow');
  assert.equal(result.shouldBlock, false);
  assert.equal(result.shouldWarn, false);
  assert.equal(result.message, '');
});

test('lockfileDiff: formats transitive major summary', () => {
  const result = {
    transitiveMajorCount: 3,
    shouldBlock: true,
    shouldWarn: false
  };

  const summary = formatTransitiveMajorSummary(result);

  assert.match(summary, /3 detected/);
  assert.match(summary, /BLOCKED/);
});

test('lockfileDiff: default transitive major policy is warn', () => {
  assert.equal(DEFAULT_TRANSITIVE_MAJOR_POLICY, 'warn');
  assert.ok(TRANSITIVE_MAJOR_POLICIES.includes('block'));
  assert.ok(TRANSITIVE_MAJOR_POLICIES.includes('warn'));
  assert.ok(TRANSITIVE_MAJOR_POLICIES.includes('allow'));
});

test('configLifecycle: default retention policy is keep', () => {
  assert.equal(DEFAULT_CONFIG_RETENTION_POLICY, 'keep');
  assert.ok(CONFIG_RETENTION_POLICIES.includes('keep'));
  assert.ok(CONFIG_RETENTION_POLICIES.includes('delete'));
});

test('configLifecycle: keep policy does not delete config', async (t) => {
  const tempDir = await makeTempDir(t);
  const configPath = path.join(tempDir, 'bridge.config.json');

  await fs.writeFile(configPath, '{}', 'utf8');

  const result = await cleanupLocalConfigAfterSuccessfulPush(
    tempDir,
    'bridge.config.json',
    { retentionPolicy: 'keep' }
  );

  assert.equal(result.removed, false);
  assert.equal(result.reason, 'policy_keep');
  assert.equal(result.policy, 'keep');

  const exists = await fs.access(configPath).then(() => true).catch(() => false);
  assert.equal(exists, true);
});

test('configLifecycle: delete policy removes untracked config', async (t) => {
  const tempDir = await makeTempDir(t);
  const configPath = path.join(tempDir, 'bridge.config.json');

  await fs.writeFile(configPath, '{}', 'utf8');

  const result = await cleanupLocalConfigAfterSuccessfulPush(
    tempDir,
    'bridge.config.json',
    { retentionPolicy: 'delete' }
  );

  assert.equal(result.removed, true);
  assert.equal(result.reason, 'untracked_first_init');
  assert.equal(result.policy, 'delete');

  const exists = await fs.access(configPath).then(() => true).catch(() => false);
  assert.equal(exists, false);
});

test('audit: BLOCKING_SEVERITIES contains critical and high', () => {
  assert.ok(BLOCKING_SEVERITIES.includes('critical'));
  assert.ok(BLOCKING_SEVERITIES.includes('high'));
  assert.equal(BLOCKING_SEVERITIES.length, 2);
});

test('audit: SEVERITIES contains all severity levels', () => {
  assert.ok(SEVERITIES.includes('info'));
  assert.ok(SEVERITIES.includes('low'));
  assert.ok(SEVERITIES.includes('moderate'));
  assert.ok(SEVERITIES.includes('high'));
  assert.ok(SEVERITIES.includes('critical'));
  assert.equal(SEVERITIES.length, 5);
});

test('scriptDiff: after-only failures are not labeled as introduced by the update', () => {
  const beforeResults = captureScriptResults([]);
  const afterResults = captureScriptResults([
    { command: 'npm run lint:ci', success: false, code: 1, stdout: 'no-console\n' }
  ]);
  const comparison = compareScriptResults(beforeResults, afterResults, {
    beforeCommands: []
  });
  const gate = evaluateScriptValidationGate(comparison, { label: 'root' });

  assert.equal(comparison.hasNewFailures, true);
  assert.equal(comparison.newFailures[0].notMeasuredOnBaseline, true);
  assert.equal(gate.shouldBlock, true);
  assert.match(gate.blockingMessages[0], /was not in beforeScripts/);
  assert.doesNotMatch(gate.blockingMessages[0], /introduced by the update/);
  assert.doesNotMatch(gate.blockingMessages[0], /not present on the committed baseline/);
});


test('scriptDiff: all passing scripts reports no failures', () => {
  const beforeResults = captureScriptResults([
    { command: 'npm run lint', success: true, code: 0 }
  ]);

  const afterResults = captureScriptResults([
    { command: 'npm run lint', success: true, code: 0 }
  ]);

  const comparison = compareScriptResults(beforeResults, afterResults);

  assert.equal(comparison.newFailureCount, 0);
  assert.equal(comparison.baselineFailureCount, 0);
  assert.equal(comparison.hasNewFailures, false);
  assert.equal(comparison.hasBaselineNoise, false);
});

test('audit: improvements are tracked when vulnerabilities decrease', () => {
  const before = {
    parsed: true,
    counts: { info: 0, low: 5, moderate: 3, high: 2, critical: 1, total: 11 }
  };

  const after = {
    parsed: true,
    counts: { info: 0, low: 3, moderate: 2, high: 1, critical: 0, total: 6 }
  };

  const comparison = compareAuditSnapshots(before, after);

  assert.equal(comparison.improvements, 5);
  assert.equal(comparison.regressions, 0);
  assert.equal(comparison.regressed, false);
  assert.equal(comparison.blocked, false);
});

test('script lifecycle: beforeScripts run before update; afterScripts run after', () => {
  const beforeIndex = SCOPE_WORKFLOW_PHASE_ORDER.indexOf('beforeScripts');
  const updateIndex = SCOPE_WORKFLOW_PHASE_ORDER.indexOf('update');
  const afterIndex = SCOPE_WORKFLOW_PHASE_ORDER.indexOf('afterScripts');
  const baselineInstallIndex = SCOPE_WORKFLOW_PHASE_ORDER.indexOf('baseline_install');
  const candidateIndex = SCOPE_WORKFLOW_PHASE_ORDER.indexOf('candidate_reinstall');

  assert.ok(baselineInstallIndex < beforeIndex);
  assert.ok(beforeIndex < updateIndex);
  assert.ok(updateIndex < candidateIndex);
  assert.ok(candidateIndex < afterIndex);

  const observed = describeScriptLifecycleOrder([
    'audit_before:root',
    'baseline_lockfile:root',
    'baseline_clean:root',
    'baseline_install:root',
    'beforeScripts:root',
    'bundle_before:root',
    'update:root',
    'candidate_reinstall:root',
    'audit_after:root',
    'afterScripts:root',
    'scriptDiff:root',
    'bundle_after:root'
  ]);

  assert.equal(observed.beforeScriptsRunOnBaseline, true);
  assert.equal(observed.afterScriptsRunOnCandidate, true);
});

test('script gate: new after-script failures block push/PR', () => {
  const beforeResults = captureScriptResults([
    { command: 'npm run lint', success: true, code: 0 }
  ]);
  const afterResults = captureScriptResults([
    { command: 'npm run lint', success: false, code: 1 }
  ]);
  const comparison = compareScriptResults(beforeResults, afterResults);
  const gate = evaluateScriptValidationGate(comparison, { label: 'root' });

  assert.equal(gate.shouldBlock, true);
  assert.equal(gate.allowPush, false);
  assert.match(gate.blockingMessages[0], /NEW after-script failure introduced by the update/);
  assert.match(gate.blockingMessages[0], /Stopping before push\/PR/);
  assert.match(formatValidationGateReason(comparison), /blocking push\/PR/);
  assert.match(formatValidationPrLine(comparison, 'root'), /NEW failure\(s\) introduced by the update/);
});

test('script gate: pre-existing baseline failures do not block push/PR', () => {
  const beforeResults = captureScriptResults([
    { command: 'npm run lint', success: false, code: 1 }
  ]);
  const afterResults = captureScriptResults([
    { command: 'npm run lint', success: false, code: 1 }
  ]);
  const comparison = compareScriptResults(beforeResults, afterResults);
  const gate = evaluateScriptValidationGate(comparison, { label: 'root' });

  assert.equal(comparison.hasNewFailures, false);
  assert.equal(comparison.hasBaselineNoise, true);
  assert.equal(gate.shouldBlock, false);
  assert.equal(gate.allowPush, true);
  assert.equal(gate.blockingMessages.length, 0);
  assert.match(gate.notices[0], /pre-existing baseline script failure/);
  assert.match(gate.notices[0], /do not block push\/PR/);
  assert.doesNotMatch(gate.notices[0], /persist \(not blocking\)/);
  assert.doesNotMatch(formatBaselinePersistNotice('root', 1), /persist \(not blocking\)/);
  assert.match(
    formatNewFailureBlockMessage('root', { command: 'npm test', exitCode: 1 }),
    /Stopping before push\/PR/
  );
});

test('scriptDiff: new error lines inside an already-failing command are NEW failures', () => {
  const beforeResults = captureScriptResults([
    {
      command: 'node scripts/masked.mjs',
      success: false,
      code: 1,
      stderr: 'BASELINE_ERROR: known lint failure\n'
    }
  ]);
  const afterResults = captureScriptResults([
    {
      command: 'node scripts/masked.mjs',
      success: false,
      code: 1,
      stderr:
        'BASELINE_ERROR: known lint failure\nNEW_ERROR: introduced by the update\n'
    }
  ]);

  const comparison = compareScriptResults(beforeResults, afterResults);
  const gate = evaluateScriptValidationGate(comparison, { label: 'root' });

  assert.equal(comparison.hasNewFailures, true);
  assert.equal(comparison.hasBaselineNoise, false);
  assert.equal(comparison.hasOutputChangedFailures, true);
  assert.equal(comparison.newFailures[0].outputChanged, true);
  assert.equal(gate.shouldBlock, true);
  assert.match(gate.blockingMessages[0], /already-failing command/);
  assert.match(formatValidationGateReason(comparison), /already-failing command/);
});

test('scriptDiff: identical failing output stays baseline noise', () => {
  const output = 'error  no-unused-expressions  bridge.config.json:1:1\n';
  const beforeResults = captureScriptResults([
    { command: 'eslint .', success: false, code: 1, stdout: output }
  ]);
  const afterResults = captureScriptResults([
    { command: 'eslint .', success: false, code: 1, stdout: output }
  ]);

  const comparison = compareScriptResults(beforeResults, afterResults);

  assert.equal(comparison.hasNewFailures, false);
  assert.equal(comparison.hasBaselineNoise, true);
});

test('scriptDiff: prettier-style extra file in failing output is a new failure', () => {
  const beforeResults = captureScriptResults([
    {
      command: 'prettier --check .',
      success: false,
      code: 1,
      stdout: 'bridge.config.json\nCode style issues found in the above file.\n'
    }
  ]);
  const afterResults = captureScriptResults([
    {
      command: 'prettier --check .',
      success: false,
      code: 1,
      stdout:
        'bridge.config.json\ntypings/index.d.ts\nCode style issues found in the above files.\n'
    }
  ]);

  const comparison = compareScriptResults(beforeResults, afterResults);

  assert.equal(comparison.hasNewFailures, true);
  assert.ok(comparison.newFailures[0].addedErrorLines.some((line) => /index\.d\.ts/.test(line)));
});

test('scriptDiff: unstructured output change is treated as a new failure (conservative)', () => {
  const beforeResults = captureScriptResults([
    { command: 'npm test', success: false, code: 1, stdout: 'TAP version 13\n1..1\n' }
  ]);
  const afterResults = captureScriptResults([
    { command: 'npm test', success: false, code: 1, stdout: 'TAP version 13\n1..2\n' }
  ]);

  const comparison = compareScriptResults(beforeResults, afterResults);

  assert.equal(comparison.hasNewFailures, true);
  assert.equal(comparison.newFailures[0].outputChanged, true);
  assert.equal(comparison.newFailures[0].conservativeMatch, true);
});

test('scriptDiff: vitest Start at clock noise is not a new failure', () => {
  const before = [
    ' RUN  v3.2.0 /tmp/bridge-a',
    ' ❯ src/always-fail.test.ts (1)',
    '   × adds numbers 2ms',
    '     → expected 2 to be 3',
    '   Start at  16:01:24',
    '   Duration  791ms (transform 12ms, setup 0ms)'
  ].join('\n');
  const after = [
    ' RUN  v3.2.0 /tmp/bridge-b',
    ' ❯ src/always-fail.test.ts (1)',
    '   × adds numbers 5ms',
    '     → expected 2 to be 3',
    '   Start at  16:02:01',
    '   Duration  812ms (transform 14ms, setup 0ms)'
  ].join('\n');

  const comparison = compareScriptResults(
    captureScriptResults([{ command: 'npm test -- --run', success: false, code: 1, stdout: before }]),
    captureScriptResults([{ command: 'npm test -- --run', success: false, code: 1, stdout: after }])
  );

  assert.equal(comparison.hasNewFailures, false);
  assert.equal(comparison.hasBaselineNoise, true);
});

test('scriptDiff: node:test duration_ms noise is not a new failure', () => {
  const before = [
    'TAP version 13',
    '1..1',
    'not ok 1 adds numbers',
    '  ---',
    '  duration_ms: 3.331321',
    '  type: \'test\'',
    '  ...',
    '# tests 1',
    '# fail 1',
    '# duration 12.4ms'
  ].join('\n');
  const after = [
    'TAP version 13',
    '1..1',
    'not ok 1 adds numbers',
    '  ---',
    '  duration_ms: 4.8821',
    '  type: \'test\'',
    '  ...',
    '# tests 1',
    '# fail 1',
    '# duration 18.1ms'
  ].join('\n');

  const comparison = compareScriptResults(
    captureScriptResults([{ command: 'npm test', success: false, code: 1, stdout: before }]),
    captureScriptResults([{ command: 'npm test', success: false, code: 1, stdout: after }])
  );

  assert.equal(comparison.hasNewFailures, false);
  assert.equal(comparison.hasBaselineNoise, true);
});

test('scriptDiff: ISO timestamps and pids in an error are not a new failure', () => {
  const before = 'error: health check failed at 2026-09-30T22:01:27.297Z (pid 1850465)\n';
  const after = 'error: health check failed at 2026-09-30T22:02:10.111Z (pid 1850999)\n';

  const comparison = compareScriptResults(
    captureScriptResults([{ command: 'node scripts/health.mjs', success: false, code: 1, stderr: before }]),
    captureScriptResults([{ command: 'node scripts/health.mjs', success: false, code: 1, stderr: after }])
  );

  assert.equal(comparison.hasNewFailures, false);
  assert.equal(comparison.hasBaselineNoise, true);
});

test('scriptDiff: node pid warnings, host ports, heap sizes, UUIDs, and epochs are noise', () => {
  const before = [
    '(node:12345) Warning: The `util.isArray` API is deprecated',
    'listen EADDRINUSE: address already in use 127.0.0.1:59329',
    'retrying localhost:4173 and [::1]:4173',
    'heapUsed: 18432000 rss: 42100000',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    'Scavenge 12.4 (14.8) -> 13.1 (15.2) MB',
    'request-id 550e8400-e29b-41d4-a716-446655440000',
    'started at 1750000000000 (epoch 1750000000)',
    'writing /var/folders/zz/abcd/T/tmp.abc123XYZ/out.log'
  ].join('\n');
  const after = [
    '(node:98765) Warning: The `util.isArray` API is deprecated',
    'listen EADDRINUSE: address already in use 127.0.0.1:48111',
    'retrying localhost:51204 and [::1]:51204',
    'heapUsed: 22100480 rss: 51200480',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    'Scavenge 18.9 (21.0) -> 19.4 (22.1) MB',
    'request-id 123e4567-e89b-12d3-a456-426614174000',
    'started at 1760000000123 (epoch 1760000000)',
    'writing /var/folders/zz/efgh/T/tmp.Q9z8y7x6WV/out.log'
  ].join('\n');

  assert.match(normalizeFailureText(before), /\(node:<pid>\) Warning/);
  assert.match(normalizeFailureText(before), /127\.0\.0\.1:<port>/);
  assert.match(normalizeFailureText(before), /localhost:<port>/);
  assert.match(normalizeFailureText(before), /<uuid>/);
  assert.match(normalizeFailureText(before), /<timestamp>/);
  assert.doesNotMatch(normalizeFailureText(after), /98765|48111|51204|22100480|1760000000123/);

  const comparison = compareScriptResults(
    captureScriptResults([{ command: 'npm test', success: false, code: 1, stderr: before }]),
    captureScriptResults([{ command: 'npm test', success: false, code: 1, stderr: after }])
  );

  assert.equal(comparison.hasNewFailures, false);
  assert.equal(comparison.hasBaselineNoise, true);
});

test('scriptDiff: a genuine new error still blocks after pid/port/uuid noise is normalized', () => {
  const before = [
    '(node:12345) Warning: The `util.isArray` API is deprecated',
    'listen EADDRINUSE: address already in use 127.0.0.1:59329'
  ].join('\n');
  const after = [
    '(node:98765) Warning: The `util.isArray` API is deprecated',
    'listen EADDRINUSE: address already in use 127.0.0.1:48111',
    'NEW_ERROR: TypeError: cannot read property of undefined'
  ].join('\n');

  const comparison = compareScriptResults(
    captureScriptResults([{ command: 'npm test', success: false, code: 1, stderr: before }]),
    captureScriptResults([{ command: 'npm test', success: false, code: 1, stderr: after }])
  );

  assert.equal(comparison.hasNewFailures, true);
  assert.equal(comparison.newFailures[0].outputChanged, true);
  assert.ok(comparison.newFailures[0].addedErrorLines.some((line) => /NEW_ERROR/.test(line)));
});

test('scriptDiff: a genuine new error still blocks inside noisy failing output', () => {
  const before = [
    'not ok 1 known failure',
    '  duration_ms: 1.2',
    'error: health check failed at 2026-09-30T22:01:27.297Z (pid 11)'
  ].join('\n');
  const after = [
    'not ok 1 known failure',
    '  duration_ms: 4.8',
    'error: health check failed at 2026-09-30T22:02:10.111Z (pid 22)',
    'NEW_ERROR: introduced by the update'
  ].join('\n');

  const comparison = compareScriptResults(
    captureScriptResults([{ command: 'node scripts/masked.mjs', success: false, code: 1, stderr: before }]),
    captureScriptResults([{ command: 'node scripts/masked.mjs', success: false, code: 1, stderr: after }])
  );

  assert.equal(comparison.hasNewFailures, true);
  assert.equal(comparison.newFailures[0].outputChanged, true);
  assert.ok(comparison.newFailures[0].addedErrorLines.some((line) => /NEW_ERROR/.test(line)));
});

test('scriptDiff: temp paths and timings do not count as new failures', () => {
  const beforeResults = captureScriptResults([
    {
      command: 'npm test',
      success: false,
      code: 1,
      stdout: 'FAIL /tmp/bridge-repo-1/src/App.tsx (12.3ms)\nerror: no-console\n'
    }
  ]);
  const afterResults = captureScriptResults([
    {
      command: 'npm test',
      success: false,
      code: 1,
      stdout: 'FAIL /tmp/bridge-repo-9/src/App.tsx (48.1ms)\nerror: no-console\n'
    }
  ]);

  const comparison = compareScriptResults(beforeResults, afterResults);

  assert.equal(comparison.hasNewFailures, false);
  assert.equal(comparison.hasBaselineNoise, true);
});

test('script gate: blockOnBaselineFailures stops on pre-existing failures', () => {
  const beforeResults = captureScriptResults([
    { command: 'npm run lint', success: false, code: 1, stderr: 'error' }
  ]);
  const afterResults = captureScriptResults([
    { command: 'npm run lint', success: false, code: 1, stderr: 'error' }
  ]);
  const comparison = compareScriptResults(beforeResults, afterResults);
  const gate = evaluateScriptValidationGate(comparison, {
    label: 'root',
    blockOnBaselineFailures: true
  });

  assert.equal(comparison.hasNewFailures, false);
  assert.equal(gate.shouldBlock, true);
  assert.match(gate.blockingMessages[0], /blockOnBaselineFailures/);
  assert.doesNotMatch(gate.blockingMessages.join('\n'), /not blocking/);
  assert.match(
    formatValidationGateReason(comparison, { blockOnBaselineFailures: true }),
    /blockOnBaselineFailures is enabled/
  );
  assert.doesNotMatch(
    formatValidationGateReason(comparison, { blockOnBaselineFailures: true }),
    /not blocking/
  );
  assert.match(
    formatBeforeScriptsBaselineNotice(1, { blockOnBaselineFailures: true }),
    /stop the run before the update/
  );
  assert.doesNotMatch(
    formatBeforeScriptsBaselineNotice(1, { blockOnBaselineFailures: true }),
    /are not blocking/
  );
  assert.match(formatBaselineBlockNotice('root', 1), /Stopping before push\/PR/);
});

test('commandOutput: combines stdout and stderr instead of preferring stderr', () => {
  const combined = combineCommandStreams(
    '/tmp/src/App.tsx\n  1:1  error  no-console\n',
    '$ eslint .\n'
  );

  assert.match(combined, /\$ eslint \./);
  assert.match(combined, /no-console/);
});

test('commandOutput: excerpt prefers failing lines over command echoes', () => {
  const excerpt = extractFailingExcerpt(
    'typings/index.d.ts\nCode style issues found\n',
    '$ prettier --check .\n'
  );

  assert.match(excerpt, /typings\/index\.d\.ts/);
  assert.doesNotMatch(excerpt, /^\$ prettier/);
});

test('commandOutput: newErrorLines detects added findings', () => {
  const added = newErrorLines(
    'bridge.config.json\nCode style issues found',
    'bridge.config.json\ntypings/index.d.ts\nCode style issues found'
  );

  assert.ok(added.some((line) => /index\.d\.ts/.test(line)));
  assert.equal(
    failureOutputChanged('same error', 'same error').changed,
    false
  );
});
