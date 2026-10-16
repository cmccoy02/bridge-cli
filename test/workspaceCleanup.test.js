import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  exitCodeForSignal,
  isBridgeTempWorkspaceName,
  removeWorkspace,
  sweepStaleBridgeWorkspaces
} from '../src/core/workspaceCleanup.js';

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-cleanup-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

test('bridge temp workspace names match the isolated copy pattern', () => {
  assert.equal(isBridgeTempWorkspaceName('bridge-travelpassbook.com-1790805719488'), true);
  assert.equal(isBridgeTempWorkspaceName('bridge-cleanup-abc'), false);
  assert.equal(isBridgeTempWorkspaceName('not-bridge-1'), false);
});

test('removeWorkspace deletes the isolated copy', async (t) => {
  const root = await makeTempDir(t);
  const workspace = path.join(root, 'bridge-repo-1');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'keep.txt'), 'x\n', 'utf8');

  await removeWorkspace(workspace);
  await assert.rejects(() => fs.access(workspace));
});

test('sweepStaleBridgeWorkspaces removes old /tmp/bridge-* dirs only', async (t) => {
  const tmpDir = await makeTempDir(t);
  const stale = path.join(tmpDir, 'bridge-repo-1000');
  const fresh = path.join(tmpDir, 'bridge-repo-2000');
  const other = path.join(tmpDir, 'unrelated');
  await fs.mkdir(stale);
  await fs.mkdir(fresh);
  await fs.mkdir(other);
  await fs.writeFile(path.join(stale, 'a.txt'), 'stale\n', 'utf8');
  await fs.writeFile(path.join(fresh, 'a.txt'), 'fresh\n', 'utf8');
  await fs.writeFile(path.join(other, 'a.txt'), 'other\n', 'utf8');

  const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(stale, staleTime, staleTime);

  const removed = await sweepStaleBridgeWorkspaces({
    tmpDir,
    maxAgeMs: 24 * 60 * 60 * 1000
  });

  assert.deepEqual(removed, [stale]);
  await assert.rejects(() => fs.access(stale));
  await fs.access(fresh);
  await fs.access(other);
});

test('signal exit codes match conventional 128+n values', () => {
  assert.equal(exitCodeForSignal('SIGINT'), 130);
  assert.equal(exitCodeForSignal('SIGTERM'), 143);
});

test('SIGINT handler removes the workspace and writes a partial report', async (t) => {
  const root = await makeTempDir(t);
  const workspace = path.join(root, 'bridge-repo-123');
  const reportPath = path.join(root, 'partial-report.json');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'blob.bin'), 'x'.repeat(1024), 'utf8');

  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { installRunSignalHandlers, removeWorkspace, exitCodeForSignal } from ${JSON.stringify(fileURLToPath(new URL('../src/core/workspaceCleanup.js', import.meta.url)))};
      import fs from 'node:fs/promises';
      const workspace = ${JSON.stringify(workspace)};
      const reportPath = ${JSON.stringify(reportPath)};
      installRunSignalHandlers(async (signal) => {
        await fs.writeFile(reportPath, JSON.stringify({ status: 'cancelled', signal }));
        await removeWorkspace(workspace);
        process.exit(exitCodeForSignal(signal));
      });
      setInterval(() => {}, 1000);
      `
    ],
    { cwd: root, stdio: 'ignore' }
  );

  t.after(() => {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 200));
  child.kill('SIGINT');
  const code = await new Promise((resolve) => child.on('close', resolve));

  assert.equal(code, 130);
  await assert.rejects(() => fs.access(workspace));
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(report.status, 'cancelled');
  assert.equal(report.signal, 'SIGINT');
});
