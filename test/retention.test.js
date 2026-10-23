import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { logActivity } from '../src/core/activityLogger.js';
import { applyRetention } from '../src/core/retention.js';

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-retention-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

async function withBridgeHome(t, fn) {
  const bridgeHome = await makeTempDir(t);
  const previous = process.env.BRIDGE_HOME;
  process.env.BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.BRIDGE_HOME;
    } else {
      process.env.BRIDGE_HOME = previous;
    }
  });
  return fn(bridgeHome);
}

test('applyRetention deletes aged run dirs and keeps the current run', async (t) => {
  await withBridgeHome(t, async (bridgeHome) => {
    const runsDir = path.join(bridgeHome, 'runs');
    await fs.mkdir(path.join(runsDir, 'old-run'), { recursive: true });
    await fs.writeFile(path.join(runsDir, 'old-run', 'bridge-report.v1.json'), '{}\n', 'utf8');
    await fs.mkdir(path.join(runsDir, 'keep-me'), { recursive: true });
    await fs.writeFile(path.join(runsDir, 'keep-me', 'bridge-report.v1.json'), '{}\n', 'utf8');

    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(runsDir, 'old-run'), oldTime, oldTime);

    const result = await applyRetention({
      bridgeHome,
      settings: {
        retention: { maxAgeDays: 30, maxRuns: 100, maxLogBytes: 1024 * 1024 }
      },
      keepRunIds: ['keep-me']
    });

    assert.ok(result.removedRuns.includes('old-run'));
    await fs.access(path.join(runsDir, 'keep-me'));
    await assert.rejects(() => fs.access(path.join(runsDir, 'old-run')));
  });
});

test('applyRetention caps run count by deleting the oldest first', async (t) => {
  await withBridgeHome(t, async (bridgeHome) => {
    const runsDir = path.join(bridgeHome, 'runs');
    for (const [index, id] of ['run-a', 'run-b', 'run-c'].entries()) {
      const dir = path.join(runsDir, id);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'bridge-report.v1.json'), '{}\n', 'utf8');
      const stamp = new Date(Date.now() - (3 - index) * 60 * 1000);
      await fs.utimes(dir, stamp, stamp);
    }

    const result = await applyRetention({
      bridgeHome,
      settings: {
        retention: { maxAgeDays: 30, maxRuns: 2, maxLogBytes: 1024 * 1024 }
      }
    });

    assert.ok(result.removedRuns.includes('run-a'));
    await fs.access(path.join(runsDir, 'run-b'));
    await fs.access(path.join(runsDir, 'run-c'));
    await assert.rejects(() => fs.access(path.join(runsDir, 'run-a')));
  });
});

test('applyRetention trims old operations.log lines', async (t) => {
  await withBridgeHome(t, async (bridgeHome) => {
    const oldAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const freshAt = new Date().toISOString();
    await logActivity('run_started', { runId: 'fresh', at: freshAt });
    const logPath = path.join(bridgeHome, 'logs', 'operations.log');
    const existing = await fs.readFile(logPath, 'utf8');
    await fs.writeFile(
      logPath,
      `${JSON.stringify({ at: oldAt, event: 'run_started', runId: 'stale' })}\n${existing}`,
      'utf8'
    );

    const result = await applyRetention({
      bridgeHome,
      settings: {
        retention: { maxAgeDays: 30, maxRuns: 100, maxLogBytes: 1024 * 1024 }
      }
    });

    const kept = await fs.readFile(logPath, 'utf8');
    assert.ok(result.log.removed >= 1);
    assert.doesNotMatch(kept, /"runId":"stale"/);
    assert.match(kept, /"runId":"fresh"/);
  });
});
