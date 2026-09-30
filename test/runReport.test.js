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
  assert.match(evidence, /--- stderr ---/);
});

test('failure evidence includes both stdout and stderr', async (t) => {
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

  const failure = Object.assign(new Error('NEW after-script failure'), {
    command: 'pnpm run test:lint',
    code: 1,
    stderr: '$ eslint .\n',
    stdout: 'src/App.tsx\n  1:1  error  no-console\n'
  });
  const failurePath = await writeFailureEvidence('run-streams', failure);
  const evidence = await fs.readFile(failurePath, 'utf8');

  assert.match(evidence, /--- stderr ---/);
  assert.match(evidence, /\$ eslint \./);
  assert.match(evidence, /--- stdout ---/);
  assert.match(evidence, /no-console/);
});

test('blocked run reports include validation, gate decisions, and blockedCount', async (t) => {
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
  await logRunEnd(run, 'failed');

  const { report } = await writeRunReport({
    run,
    status: 'failed',
    validationResults: [
      {
        label: 'root',
        scriptDiff: { diff: { hasNewFailures: true } },
        comparison: {
          hasNewFailures: true,
          newFailureCount: 1,
          baselineFailureCount: 0,
          resolvedCount: 0,
          newFailures: [{ command: 'npm test', exitCode: 1, outputChanged: true }]
        }
      }
    ],
    auditResults: [
      {
        label: 'root',
        comparison: { comparable: true, blocked: true, blockReason: 'high +1' }
      }
    ],
    blockedCount: 1,
    earlyExit: { code: 'validation_block', message: 'Blocked by validation script failure' },
    environment: { nodeVersion: 'v22.0.0', npmVersion: '10.9.8', platform: 'linux', arch: 'x64' }
  });

  assert.equal(report.outcome.validation[0].hasNewFailures, true);
  assert.ok(report.outcome.gateDecisions.some((decision) => decision.gate === 'validation' && !decision.passed));
  assert.ok(report.outcome.blockedCount >= 1);
  assert.equal(report.outcome.earlyExit.code, 'validation_block');
  assert.equal(report.environment.npmVersion, '10.9.8');
});

test('blocked baseline failures are recorded as failed validation gates', async (t) => {
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
  await logRunEnd(run, 'failed');

  const { report } = await writeRunReport({
    run,
    status: 'failed',
    validationResults: [
      {
        label: 'root',
        blocked: true,
        comparison: {
          hasNewFailures: false,
          hasBaselineNoise: true,
          newFailureCount: 0,
          baselineFailureCount: 1,
          resolvedCount: 0
        }
      }
    ],
    blockedCount: 1,
    earlyExit: { code: 'validation_block', message: 'Blocked by baseline failures' }
  });

  assert.equal(report.outcome.validation[0].hasBaselineNoise, true);
  assert.ok(report.outcome.gateDecisions.some((decision) => decision.gate === 'validation' && !decision.passed));
  assert.ok(report.outcome.blockedCount >= 1);
});
