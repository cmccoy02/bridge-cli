import path from 'node:path';

import { getBridgeHome } from './bridgeHome.js';
import { acquireDirLock, withDirLock } from './fileLock.js';
import { sanitizeWorkspaceSegment } from './workspaceCleanup.js';

export function getPatchLockDir(lockKey, bridgeHome = getBridgeHome()) {
  return path.join(bridgeHome, 'locks', 'patch', `${sanitizeWorkspaceSegment(lockKey)}.lock`);
}

export function resolvePatchLockKey({ cwd = '', repoName = '', originUrl = '' } = {}) {
  const raw = String(originUrl || '').trim() || path.resolve(cwd || process.cwd()) || repoName;
  return sanitizeWorkspaceSegment(raw);
}

export async function acquirePatchLock(lockKey, options = {}) {
  return acquireDirLock(getPatchLockDir(lockKey), {
    retries: options.retries ?? 3,
    delayMs: options.delayMs ?? 25,
    staleMs: options.staleMs ?? 2 * 60 * 60 * 1000,
    required: true
  });
}

export async function withPatchLock(lockKey, fn, options = {}) {
  return withDirLock(getPatchLockDir(lockKey), fn, {
    retries: options.retries ?? 3,
    delayMs: options.delayMs ?? 25,
    staleMs: options.staleMs ?? 2 * 60 * 60 * 1000,
    required: true
  });
}
