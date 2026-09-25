import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AGENT_TELEMETRY_SCHEMA_VERSION,
  AgentEventStream,
  buildAgentReport,
  computeFileSha256,
  computeStringSha256,
  createEarlyExitReason,
  createPhaseTiming,
  getAgentEventStreamPath,
  getDetailedEnvironment
} from '../src/core/agentTelemetry.js';

test('computeStringSha256 returns correct SHA256 hash for strings', async (t) => {
  const hash = computeStringSha256('hello world');
  assert.equal(
    hash,
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
  );

  const emptyHash = computeStringSha256('');
  assert.equal(
    emptyHash,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
});

test('computeStringSha256 returns empty string for non-string input', async (t) => {
  assert.equal(computeStringSha256(null), '');
  assert.equal(computeStringSha256(undefined), '');
  assert.equal(computeStringSha256(123), '');
  assert.equal(computeStringSha256({}), '');
});

test('computeFileSha256 returns hash for existing file', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
  const testFile = path.join(tempDir, 'test.txt');

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await fs.writeFile(testFile, 'test content', 'utf8');
  const hash = await computeFileSha256(testFile);

  assert.equal(
    hash,
    '6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72'
  );
});

test('computeFileSha256 returns empty string for missing file', async (t) => {
  const hash = await computeFileSha256('/nonexistent/path/to/file.txt');
  assert.equal(hash, '');
});

test('getDetailedEnvironment returns expected structure', async (t) => {
  const env = getDetailedEnvironment();

  assert.ok(typeof env.nodeVersion === 'string');
  assert.ok(env.nodeVersion.startsWith('v'));
  assert.ok(typeof env.nodeVersionNumeric === 'string');
  assert.ok(typeof env.platform === 'string');
  assert.ok(typeof env.arch === 'string');
  assert.ok(typeof env.osRelease === 'string');
  assert.ok(typeof env.osType === 'string');
  assert.ok(typeof env.cpuCount === 'number');
  assert.ok(env.cpuCount > 0);
  assert.ok(typeof env.totalMemoryMb === 'number');
  assert.ok(env.totalMemoryMb > 0);
});

test('getAgentEventStreamPath returns correct path structure', async (t) => {
  const runId = 'patch-1234567890-abc123';
  const streamPath = getAgentEventStreamPath(runId);

  assert.ok(streamPath.includes('runs'));
  assert.ok(streamPath.includes(runId));
  assert.ok(streamPath.endsWith(`${AGENT_TELEMETRY_SCHEMA_VERSION}.jsonl`));
});

test('AgentEventStream emits events to JSONL file', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-'));
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

  const runId = 'test-run-123';
  const stream = new AgentEventStream(runId);

  await stream.emitRunStart({ command: 'patch', dryRun: false });
  await stream.emit('custom_event', { foo: 'bar' });
  await stream.emitRunEnd('success', { changedFilesCount: 5 });

  const streamPath = getAgentEventStreamPath(runId);
  const content = await fs.readFile(streamPath, 'utf8');
  const events = content.trim().split('\n').map(line => JSON.parse(line));

  assert.equal(events.length, 3);
  assert.equal(events[0].event, 'run_started');
  assert.equal(events[0].schemaVersion, AGENT_TELEMETRY_SCHEMA_VERSION);
  assert.ok(events[0].environment);
  assert.equal(events[1].event, 'custom_event');
  assert.equal(events[1].foo, 'bar');
  assert.equal(events[2].event, 'run_finished');
  assert.equal(events[2].status, 'success');
});

test('AgentEventStream phase timing tracks durations', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-'));
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

  const runId = 'test-phase-timing';
  const stream = new AgentEventStream(runId);

  stream.startPhase('install');
  await new Promise(resolve => setTimeout(resolve, 10));
  const phaseData = await stream.endPhase('install', 'success', { scope: 'root' });

  assert.equal(phaseData.phase, 'install');
  assert.equal(phaseData.status, 'success');
  assert.ok(phaseData.durationMs >= 10);
  assert.ok(phaseData.startedAt);
  assert.ok(phaseData.finishedAt);
});

test('createEarlyExitReason returns structured reason', async (t) => {
  const noUpdates = createEarlyExitReason('no_updates');
  assert.equal(noUpdates.code, 'no_updates');
  assert.ok(noUpdates.message.includes('No dependency'));

  const upToDate = createEarlyExitReason('up_to_date');
  assert.equal(upToDate.code, 'up_to_date');
  assert.ok(upToDate.message.includes('up to date'));

  const custom = createEarlyExitReason('custom_reason', { extra: 'data' });
  assert.equal(custom.code, 'custom_reason');
  assert.equal(custom.extra, 'data');
});

test('createPhaseTiming returns empty timing structure', async (t) => {
  const timing = createPhaseTiming();

  assert.ok('install' in timing);
  assert.ok('update' in timing);
  assert.ok('beforeScripts' in timing);
  assert.ok('afterScripts' in timing);
  assert.ok('audit' in timing);
  assert.ok('bundle' in timing);
  assert.ok('commit' in timing);
  assert.ok('pr' in timing);
  assert.equal(timing.early_exit, null);
});

test('buildAgentReport creates complete report structure', async (t) => {
  const startedAtMs = Date.now() - 5000;
  const finishedAtMs = Date.now();

  const report = buildAgentReport({
    runId: 'test-run-456',
    startedAtMs,
    finishedAtMs,
    status: 'pushed',
    configFileSha256: 'abc123',
    configStaged: false,
    configMutated: false,
    branchName: 'bridge/patch-2026-09-25',
    baseBranch: 'main',
    baseSha: 'abc123',
    headSha: 'def456',
    stagedFiles: ['package.json', 'package-lock.json'],
    prUrl: 'https://github.com/test/repo/pull/1',
    earlyExit: null,
    phaseTiming: { install: { durationMs: 1000, status: 'success' } },
    skippedCount: 0,
    blockedCount: 0
  });

  assert.equal(report.runId, 'test-run-456');
  assert.equal(report.status, 'pushed');
  assert.ok(report.durationMs >= 5000);
  assert.equal(report.git.branchName, 'bridge/patch-2026-09-25');
  assert.equal(report.git.baseBranch, 'main');
  assert.equal(report.git.baseSha, 'abc123');
  assert.equal(report.git.headSha, 'def456');
  assert.deepEqual(report.git.stagedFiles, ['package.json', 'package-lock.json']);
  assert.equal(report.config.configFileSha256, 'abc123');
  assert.equal(report.config.configStaged, false);
  assert.equal(report.config.configMutated, false);
  assert.equal(report.prUrl, 'https://github.com/test/repo/pull/1');
  assert.equal(report.earlyExit, null);
  assert.ok(report.phaseTiming.install);
});

test('AgentEventStream emitEarlyExit records reason', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-'));
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

  const runId = 'test-early-exit';
  const stream = new AgentEventStream(runId);

  await stream.emitEarlyExit('no_updates', { branchName: 'bridge/patch' });

  const streamPath = getAgentEventStreamPath(runId);
  const content = await fs.readFile(streamPath, 'utf8');
  const event = JSON.parse(content.trim());

  assert.equal(event.event, 'early_exit');
  assert.equal(event.reason, 'no_updates');
  assert.equal(event.branchName, 'bridge/patch');
});

test('AgentEventStream emitGateDecision records gate decisions', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-'));
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

  const runId = 'test-gate-decision';
  const stream = new AgentEventStream(runId);

  await stream.emitGateDecision('audit', 'root', true, 'No blocking severity increases');

  const streamPath = getAgentEventStreamPath(runId);
  const content = await fs.readFile(streamPath, 'utf8');
  const event = JSON.parse(content.trim());

  assert.equal(event.event, 'gate_decision');
  assert.equal(event.gate, 'audit');
  assert.equal(event.scope, 'root');
  assert.equal(event.passed, true);
  assert.equal(event.reason, 'No blocking severity increases');
});

test('AgentEventStream emitConfigState records config status', async (t) => {
  const bridgeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-agent-'));
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

  const runId = 'test-config-state';
  const stream = new AgentEventStream(runId);

  await stream.emitConfigState('/path/to/config.json', 'sha256hash', false, false);

  const streamPath = getAgentEventStreamPath(runId);
  const content = await fs.readFile(streamPath, 'utf8');
  const event = JSON.parse(content.trim());

  assert.equal(event.event, 'config_state');
  assert.equal(event.configPath, '/path/to/config.json');
  assert.equal(event.configFileSha256, 'sha256hash');
  assert.equal(event.configStaged, false);
  assert.equal(event.configMutated, false);
});
