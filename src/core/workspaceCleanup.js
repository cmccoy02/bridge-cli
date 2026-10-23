import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

export function sanitizeWorkspaceSegment(value) {
  const normalized = String(value || 'repo')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'repo';
}

export function isBridgeTempWorkspaceName(name) {
  return /^bridge-[a-z0-9._-]+-\d+(-[a-z0-9]+)?$/i.test(String(name || ''));
}

export async function createIsolatedWorkspace(
  repoName,
  { tmpDir = os.tmpdir(), nowMs = Date.now() } = {}
) {
  const prefix = path.join(
    tmpDir,
    `bridge-${sanitizeWorkspaceSegment(repoName)}-${nowMs}-`
  );
  return fs.mkdtemp(prefix);
}

export async function removeWorkspace(tempDir) {
  const target = String(tempDir || '').trim();

  if (!target) {
    return false;
  }

  await fs.rm(target, { recursive: true, force: true });
  return true;
}

export async function sweepStaleBridgeWorkspaces({
  tmpDir = os.tmpdir(),
  maxAgeMs = DEFAULT_STALE_MS,
  nowMs = Date.now()
} = {}) {
  let entries = [];

  try {
    entries = await fs.readdir(tmpDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isBridgeTempWorkspaceName(entry.name)) {
      continue;
    }

    const fullPath = path.join(tmpDir, entry.name);
    let stat;

    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }

    if (nowMs - stat.mtimeMs < maxAgeMs) {
      continue;
    }

    try {
      await fs.rm(fullPath, { recursive: true, force: true });
      removed.push(fullPath);
    } catch {
      // Sweep is best-effort; a live run may still hold the directory.
    }
  }

  return removed;
}

export function installRunSignalHandlers(onSignal) {
  const handler = (signal) => {
    void onSignal(signal);
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

export function exitCodeForSignal(signal) {
  if (signal === 'SIGINT') {
    return 130;
  }

  if (signal === 'SIGTERM') {
    return 143;
  }

  return 1;
}
