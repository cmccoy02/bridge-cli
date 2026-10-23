import fs from 'node:fs/promises';
import path from 'node:path';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockPid(lockDir) {
  try {
    const raw = await fs.readFile(path.join(lockDir, 'pid'), 'utf8');
    const pid = Number.parseInt(String(raw).replace(/[^\d]/g, ''), 10);
    return Number.isInteger(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

async function reclaimStaleLock(lockDir, staleMs) {
  let stat;

  try {
    stat = await fs.stat(lockDir);
  } catch {
    return false;
  }

  const pid = await readLockPid(lockDir);
  const agedOut = Date.now() - stat.mtimeMs >= staleMs;

  if ((pid && !(await isProcessAlive(pid))) || (!pid && agedOut) || agedOut) {
    await fs.rm(lockDir, { recursive: true, force: true });
    return true;
  }

  return false;
}

export class LockBusyError extends Error {
  constructor(lockDir) {
    super(`another Bridge run holds ${lockDir}`);
    this.name = 'LockBusyError';
    this.code = 'LOCK_BUSY';
    this.lockDir = lockDir;
  }
}

export async function acquireDirLock(
  lockDir,
  { retries = 80, delayMs = 15, staleMs = 30_000, required = false } = {}
) {
  const parent = path.dirname(lockDir);
  await fs.mkdir(parent, { recursive: true });

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(path.join(lockDir, 'pid'), `${process.pid}\n`, 'utf8');

      return {
        lockDir,
        async release() {
          await fs.rm(lockDir, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      if (attempt === 0 || attempt % 10 === 0) {
        await reclaimStaleLock(lockDir, staleMs);
      }

      await sleep(delayMs + Math.random() * delayMs);
    }
  }

  if (required) {
    throw new LockBusyError(lockDir);
  }

  return {
    lockDir,
    async release() {}
  };
}

export async function withDirLock(lockDir, fn, options = {}) {
  const handle = await acquireDirLock(lockDir, options);

  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
