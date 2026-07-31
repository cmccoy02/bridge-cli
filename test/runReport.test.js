import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  logDepDelta,
  logPhase,
  logRunEnd,
  logRunStart,
  makeRunContext
} from '../src/core/activityLogger.js';
import {
  findSavedRunReport,
  getRunFailurePath,
  writeFailureEvidence,
  writeRunReport
} from '../src/core/runReport.js';

test('saved run reports retain useful evidence and redact command output', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-report-'));
  const previousBridgeHome = process.env.BRIDGE_HOME;
  process.env.BRIDGE_HOME = bridgeHome;

  t.after(async () => {
    if (previousBridgeHome === undefined) {
      delete process.env.BRIDGE_HOME;
    } else {
      process.env.BRIDGE_HOME = previousBridgeHome;
    }
    await fs.rm(bridgeHome, { recursive: true, force: true });
  });

  const run = makeRunContext('patch', '/tmp/example-project');
  await logRunStart(run, { dryRun: true });
  await logPhase(run, 'install:root', 'success', { durationMs: 12 });
  await logDepDelta(run, {
    repo: 'example-project',
    manager: 'npm',
    scope: 'root',
    name: 'example',
    from: '1.0.0',
    to: '1.0.1',
    bump: 'patch',
    kind: 'direct'
  });
  await logPhase(run, 'audit_before:root', 'success', {
    scope: 'root',
    counts: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 }
  });
  await logPhase(run, 'audit_after:root', 'success', {
    scope: 'root',
    counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }
  });
  await logPhase(run, 'bundle_comparison:root', 'success', {
    scope: 'root',
    metric: 'brotli',
    beforeBytes: 100,
    afterBytes: 102,
    deltaBytes: 2,
    deltaPercent: 2,
    regressed: true,
    thresholdExceeded: false,
    percentExceeded: false,
    bytesExceeded: false
  });
  await logRunEnd(run, 'failed');

  const failure = Object.assign(new Error('Command failed: npm run lint:ci'), {
    command: 'npm run lint:ci',
    code: 1,
    stderr: 'token=should-not-appear\nlint failed'
  });
  const failurePath = await writeFailureEvidence(run.runId, failure);
  const { report, reportPath } = await writeRunReport({
    run,
    status: 'failed',
    repo: 'example-project',
    configPath: '/tmp/example-project/bridge.config.json',
    dryRun: true,
    branchName: 'bridge/patch-test',
    failure,
    failurePath
  });
  const evidence = await fs.readFile(getRunFailurePath(run.runId), 'utf8');
  const saved = await findSavedRunReport(run.runId);

  assert.equal(report.schemaVersion, 'bridge-report.v1');
  assert.equal(report.run.status, 'failed');
  assert.equal(report.phases.length, 4);
  assert.equal(report.outcome.dependencySummary.totalChanged, 1);
  assert.equal(report.outcome.audits[0].comparison.delta.total, -1);
  assert.equal(report.outcome.bundles[0].comparison.deltaBytes, 2);
  assert.ok(report.artifacts.includes(failurePath));
  assert.doesNotMatch(evidence, /should-not-appear/);
  assert.match(evidence, /\[redacted\]/);
  assert.equal(saved.reportPath, reportPath);
  assert.equal(saved.report.run.id, run.runId);
});
