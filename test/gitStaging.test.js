import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isolateUntrackedBridgeConfig } from '../src/core/configLifecycle.js';
import { runCommand } from '../src/core/executor.js';
import { isDependencyArtifactPath, stageDependencyChanges } from '../src/core/git.js';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Bridge Test',
  GIT_AUTHOR_EMAIL: 'bridge@example.test',
  GIT_COMMITTER_NAME: 'Bridge Test',
  GIT_COMMITTER_EMAIL: 'bridge@example.test'
};

async function git(cwd, args) {
  return runCommand(`git ${args}`, { cwd, quiet: true, env: gitEnv });
}

async function makeRepo(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-stage-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  await git(tempDir, 'init');
  await git(tempDir, 'config user.name "Bridge Test"');
  await git(tempDir, 'config user.email bridge@example.test');
  await fs.writeFile(path.join(tempDir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  await git(tempDir, 'add package.json');
  await git(tempDir, 'commit -m initial');
  return tempDir;
}

test('isDependencyArtifactPath allows manifests and lockfiles only', () => {
  assert.equal(isDependencyArtifactPath('package-lock.json'), true);
  assert.equal(isDependencyArtifactPath('apps/web/pnpm-lock.yaml'), true);
  assert.equal(isDependencyArtifactPath('node_modules/ms/index.js'), false);
  assert.equal(isDependencyArtifactPath('bridge.config.json'), false);
});

test('stageDependencyChanges stages lockfiles and skips node_modules', async (t) => {
  const repo = await makeRepo(t);
  await fs.writeFile(path.join(repo, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n', 'utf8');
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8');
  await fs.mkdir(path.join(repo, 'node_modules', 'ms'), { recursive: true });
  await fs.writeFile(path.join(repo, 'node_modules', 'ms', 'index.js'), 'module.exports=1;\n', 'utf8');
  await fs.writeFile(path.join(repo, 'README.md'), 'notes\n', 'utf8');

  const result = await stageDependencyChanges(repo);
  assert.ok(result.staged.includes('package.json'));
  assert.ok(result.staged.includes('package-lock.json'));
  assert.ok(result.skipped.some((file) => file.includes('node_modules')));
  assert.ok(result.skipped.includes('README.md'));

  const staged = await runCommand('git diff --staged --name-only', { cwd: repo, quiet: true });
  const files = staged.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(files.sort(), ['package-lock.json', 'package.json']);
});

test('isolateUntrackedBridgeConfig moves config out of the working tree', async (t) => {
  const repo = await makeRepo(t);
  await fs.writeFile(path.join(repo, 'bridge.config.json'), '{"packageManager":"npm"}\n', 'utf8');

  const result = await isolateUntrackedBridgeConfig({
    workspaceDir: repo,
    sourceConfigPath: path.join(repo, 'bridge.config.json')
  });

  assert.equal(result.isolated, true);
  await assert.rejects(() => fs.access(path.join(repo, 'bridge.config.json')));
  await fs.access(path.join(repo, '.git', 'bridge', 'bridge.config.json'));
});
