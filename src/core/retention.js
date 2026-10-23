import fs from 'node:fs/promises';
import path from 'node:path';

import { getActivityLogPath, getLogDir, getOperationsLockDir } from './activityLogger.js';
import { getBridgeHome } from './bridgeHome.js';
import { loadBridgeSettings } from './bridgeSettings.js';
import { withDirLock } from './fileLock.js';

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function listRunDirectories(bridgeHome) {
  const runsDir = path.join(bridgeHome, 'runs');
  let entries = [];

  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const runs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(runsDir, entry.name);
    let stat;

    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }

    runs.push({
      id: entry.name,
      dir,
      mtimeMs: stat.mtimeMs
    });
  }

  return runs.sort((left, right) => left.mtimeMs - right.mtimeMs);
}

async function pruneOperationsLog({
  bridgeHome,
  maxAgeMs,
  maxLogBytes,
  nowMs
}) {
  const logPath = getActivityLogPath(bridgeHome);
  let content = '';

  try {
    content = await fs.readFile(logPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { kept: 0, removed: 0 };
    }

    throw error;
  }

  const lines = content.split(/\r?\n/);
  const keptLines = [];
  let removed = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const parsed = parseJsonLine(line);
    const atMs = Date.parse(parsed?.at || '');
    const tooOld = Number.isFinite(atMs) && nowMs - atMs > maxAgeMs;

    if (tooOld) {
      removed += 1;
      continue;
    }

    keptLines.push(line);
  }

  let trimmedForSize = 0;
  let serialized = `${keptLines.join('\n')}${keptLines.length ? '\n' : ''}`;

  while (maxLogBytes > 0 && Buffer.byteLength(serialized, 'utf8') > maxLogBytes && keptLines.length > 0) {
    keptLines.shift();
    trimmedForSize += 1;
    serialized = `${keptLines.join('\n')}${keptLines.length ? '\n' : ''}`;
  }

  const tempPath = `${logPath}.tmp-${process.pid}`;
  await fs.mkdir(getLogDir(bridgeHome), { recursive: true });
  await fs.writeFile(tempPath, serialized, 'utf8');
  await fs.rename(tempPath, logPath);

  return {
    kept: keptLines.length,
    removed: removed + trimmedForSize
  };
}

export async function applyRetention({
  bridgeHome = getBridgeHome(),
  settings = null,
  keepRunIds = [],
  nowMs = Date.now()
} = {}) {
  const resolved = settings || (await loadBridgeSettings({ bridgeHome }));
  const maxAgeDays = Number(resolved.retention?.maxAgeDays) || 30;
  const maxRuns = Number(resolved.retention?.maxRuns) || 100;
  const maxLogBytes = Number(resolved.retention?.maxLogBytes) || 10 * 1024 * 1024;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const keep = new Set(keepRunIds.map((id) => String(id)));

  const runs = await listRunDirectories(bridgeHome);
  const removedRuns = [];

  for (const run of runs) {
    if (keep.has(run.id)) {
      continue;
    }

    if (nowMs - run.mtimeMs > maxAgeMs) {
      await fs.rm(run.dir, { recursive: true, force: true });
      removedRuns.push(run.id);
    }
  }

  const remaining = (await listRunDirectories(bridgeHome)).filter((run) => !keep.has(run.id));
  const overflow = Math.max(0, remaining.length - maxRuns);

  for (const run of remaining.slice(0, overflow)) {
    await fs.rm(run.dir, { recursive: true, force: true });
    removedRuns.push(run.id);
  }

  const log = await withDirLock(getOperationsLockDir(bridgeHome), () =>
    pruneOperationsLog({
      bridgeHome,
      maxAgeMs,
      maxLogBytes,
      nowMs
    })
  );

  return {
    maxAgeDays,
    maxRuns,
    removedRuns,
    log
  };
}
