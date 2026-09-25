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
  formatBaselinePersistNotice,
  formatNewFailureBlockMessage,
  formatScriptDiffSummary,
  formatValidationGateReason,
  formatValidationPrLine
} from '../src/core/scriptDiff.js';
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

test('scriptDiff: empty before scripts with failing after scripts are new failures', () => {
  const beforeResults = captureScriptResults([]);
  const afterResults = captureScriptResults([
    { command: 'npm test', success: false, code: 1 }
  ]);

  const comparison = compareScriptResults(beforeResults, afterResults);

  assert.equal(comparison.newFailureCount, 1);
  assert.equal(comparison.baselineFailureCount, 0);
  assert.equal(comparison.hasNewFailures, true);
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
