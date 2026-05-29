import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LOG_DIR = path.join(os.homedir(), '.bridge', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'operations.log');

function safeError(error) {
  if (!error) {
    return '';
  }

  if (typeof error === 'string') {
    return error;
  }

  return error.message || String(error);
}

export async function logActivity(event, payload = {}) {
  const entry = {
    at: new Date().toISOString(),
    event,
    ...payload
  };

  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Logging should never block a patch/init/validate run.
  }
}

export function getActivityLogPath() {
  return LOG_FILE;
}

export function makeRunContext(command, cwd) {
  return {
    runId: `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    command,
    cwd,
    startedAtMs: Date.now()
  };
}

export async function logRunStart(context, details = {}) {
  await logActivity('run_started', {
    runId: context.runId,
    command: context.command,
    cwd: context.cwd,
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
