import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getBridgeHome } from './activityLogger.js';

export const AGENT_TELEMETRY_SCHEMA_VERSION = 'bridge-agent.v1';

export function computeStringSha256(content) {
  if (typeof content !== 'string') {
    return '';
  }

  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function computeFileSha256(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return computeStringSha256(content);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export function getDetailedEnvironment() {
  const npmUserAgent = process.env.npm_config_user_agent || '';
  const npmMatch = npmUserAgent.match(/npm\/(\S+)/);
  const nodeMatch = npmUserAgent.match(/node\/(\S+)/);
  const yarnMatch = npmUserAgent.match(/yarn\/(\S+)/);
  const pnpmMatch = npmUserAgent.match(/pnpm\/(\S+)/);

  let packageManagerVersion = null;
  let packageManagerName = null;

  if (pnpmMatch) {
    packageManagerName = 'pnpm';
    packageManagerVersion = pnpmMatch[1];
  } else if (yarnMatch) {
    packageManagerName = 'yarn';
    packageManagerVersion = yarnMatch[1];
  } else if (npmMatch) {
    packageManagerName = 'npm';
    packageManagerVersion = npmMatch[1];
  }

  return {
    nodeVersion: process.version,
    nodeVersionNumeric: process.version.replace(/^v/, ''),
    npmVersion: npmMatch?.[1] || null,
    packageManager: packageManagerName,
    packageManagerVersion,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osType: os.type(),
    cpuCount: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024))
  };
}

export function getAgentEventStreamPath(runId) {
  return path.join(getBridgeHome(), 'runs', String(runId), `${AGENT_TELEMETRY_SCHEMA_VERSION}.jsonl`);
}

export class AgentEventStream {
  constructor(runId) {
    this.runId = runId;
    this.streamPath = getAgentEventStreamPath(runId);
    this.enabled = true;
    this.phaseTimers = new Map();
    this.runStartMs = Date.now();
  }

  async emit(eventType, payload = {}) {
    if (!this.enabled) {
      return;
    }

    const event = {
      schemaVersion: AGENT_TELEMETRY_SCHEMA_VERSION,
      runId: this.runId,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.runStartMs,
      event: eventType,
      ...payload
    };

    try {
      await fs.mkdir(path.dirname(this.streamPath), { recursive: true });
      await fs.appendFile(this.streamPath, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // Agent telemetry should never block the run
    }
  }

  startPhase(phaseName) {
    const timer = {
      phase: phaseName,
      startedAt: Date.now(),
      startedAtIso: new Date().toISOString()
    };
    this.phaseTimers.set(phaseName, timer);
    return timer;
  }

  async endPhase(phaseName, status, details = {}) {
    const timer = this.phaseTimers.get(phaseName);
    const now = Date.now();

    const phaseData = {
      phase: phaseName,
      status,
      durationMs: timer ? now - timer.startedAt : 0,
      startedAt: timer?.startedAtIso || new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ...details
    };

    await this.emit('phase_completed', phaseData);
    this.phaseTimers.delete(phaseName);
    return phaseData;
  }

  async emitRunStart(details = {}) {
    await this.emit('run_started', {
      environment: getDetailedEnvironment(),
      ...details
    });
  }

  async emitRunEnd(status, details = {}) {
    await this.emit('run_finished', {
      status,
      totalDurationMs: Date.now() - this.runStartMs,
      ...details
    });
  }

  async emitEarlyExit(reason, details = {}) {
    await this.emit('early_exit', {
      reason,
      ...details
    });
  }

  async emitGateDecision(gate, scope, passed, reason, details = {}) {
    await this.emit('gate_decision', {
      gate,
      scope,
      passed,
      reason,
      ...details
    });
  }

  async emitConfigState(configPath, sha256, staged, mutated) {
    await this.emit('config_state', {
      configPath,
      configFileSha256: sha256,
      configStaged: staged,
      configMutated: mutated
    });
  }

  async emitDependencyDelta(summary, details = {}) {
    await this.emit('dependency_delta_summary', {
      summary,
      ...details
    });
  }
}

export function createPhaseTiming() {
  return {
    install: { durationMs: 0, status: null },
    update: { durationMs: 0, status: null },
    beforeScripts: { durationMs: 0, status: null },
    afterScripts: { durationMs: 0, status: null },
    audit: { durationMs: 0, status: null },
    bundle: { durationMs: 0, status: null },
    commit: { durationMs: 0, status: null },
    pr: { durationMs: 0, status: null },
    early_exit: null
  };
}

export function createEarlyExitReason(reason, details = {}) {
  const reasons = {
    no_updates: 'No dependency updates found across all scopes',
    up_to_date: 'All dependencies are already up to date',
    lockfile_unchanged: 'Lockfile unchanged after update',
    no_python_changes: 'No Python requirement changes',
    policy_block: 'Blocked by policy violation',
    audit_block: 'Blocked by security audit regression',
    bundle_block: 'Blocked by bundle size regression',
    validation_block: 'Blocked by validation script failure'
  };

  return {
    code: reason,
    message: reasons[reason] || reason,
    ...details
  };
}

export function buildAgentReport({
  runId,
  startedAtMs,
  finishedAtMs = Date.now(),
  status,
  configFileSha256 = '',
  configStaged = false,
  configMutated = false,
  branchName = '',
  baseBranch = '',
  baseSha = '',
  headSha = '',
  stagedFiles = [],
  prUrl = null,
  earlyExit = null,
  phaseTiming = null,
  skippedCount = 0,
  blockedCount = 0
} = {}) {
  return {
    runId,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    status,
    git: {
      branchName,
      baseBranch,
      baseSha,
      headSha,
      stagedFiles
    },
    config: {
      configFileSha256,
      configStaged,
      configMutated
    },
    prUrl,
    earlyExit,
    phaseTiming,
    skippedCount,
    blockedCount
  };
}
