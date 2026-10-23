import fs from 'node:fs/promises';
import path from 'node:path';

import { getBridgeHome } from './bridgeHome.js';
import { withDirLock } from './fileLock.js';
import { redactActivityPayload, redactSensitiveText } from './redaction.js';

export { getBridgeHome };

export function getLogDir(bridgeHome = getBridgeHome()) {
  return path.join(bridgeHome, 'logs');
}

export function getActivityLogPath(bridgeHome = getBridgeHome()) {
  return path.join(getLogDir(bridgeHome), 'operations.log');
}

export function getOperationsLockDir(bridgeHome = getBridgeHome()) {
  return path.join(getLogDir(bridgeHome), '.operations.lock');
}

export function getRunOperationsLogPath(runId, bridgeHome = getBridgeHome()) {
  return path.join(bridgeHome, 'runs', String(runId), 'operations.jsonl');
}

function safeError(error) {
  if (!error) {
    return '';
  }

  if (typeof error === 'string') {
    return redactSensitiveText(error);
  }

  return redactSensitiveText(error.message || String(error));
}

async function appendJsonLine(filePath, entry) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function logActivity(event, payload = {}) {
  const entry = {
    at: new Date().toISOString(),
    event,
    pid: process.pid,
    ...redactActivityPayload(payload)
  };

  try {
    if (entry.runId) {
      await appendJsonLine(getRunOperationsLogPath(entry.runId), entry);
    }

    await withDirLock(getOperationsLockDir(), async () => {
      await appendJsonLine(getActivityLogPath(), entry);
    });
  } catch {
    // Logging should never block a patch/init/validate run.
  }
}

export function makeRunContext(command, cwd) {
  return {
    runId: `${command}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    command,
    cwd,
    pid: process.pid,
    startedAtMs: Date.now()
  };
}

export async function logRunStart(context, details = {}) {
  await logActivity('run_started', {
    runId: context.runId,
    command: context.command,
    cwd: context.cwd,
    pid: context.pid || process.pid,
    ...details
  });
}

export async function logRunEnd(context, status, details = {}) {
  await logActivity('run_finished', {
    runId: context.runId,
    command: context.command,
    cwd: context.cwd,
    status,
    durationMs: Date.now() - context.startedAtMs,
    ...details
  });
}

export async function logPhase(context, phase, status, details = {}) {
  await logActivity('phase', {
    runId: context.runId,
    command: context.command,
    phase,
    status,
    ...details
  });
}

export async function logRunFailure(context, error, details = {}) {
  await logActivity('run_error', {
    runId: context.runId,
    command: context.command,
    cwd: context.cwd,
    error: safeError(error),
    ...details
  });
}

export async function logRunSignal(context, signal) {
  await logActivity('run_signal', {
    runId: context.runId,
    command: context.command,
    cwd: context.cwd,
    ...signal
  });
}

function resolveRepoName(context, payloadRepo = '') {
  if (payloadRepo && typeof payloadRepo === 'string' && payloadRepo.trim()) {
    return payloadRepo.trim();
  }

  if (context && typeof context.repo === 'string' && context.repo.trim()) {
    return context.repo.trim();
  }

  return path.basename(context?.cwd || process.cwd());
}

export async function logDepDelta(context, payload = {}) {
  await logActivity('dep_delta', {
    runId: context.runId,
    command: context.command,
    repo: resolveRepoName(context, payload.repo),
    ...payload
  });
}

export async function logDepDeltaSummary(context, payload = {}) {
  await logActivity('dep_delta_summary', {
    runId: context.runId,
    command: context.command,
    repo: resolveRepoName(context, payload.repo),
    ...payload
  });
}
