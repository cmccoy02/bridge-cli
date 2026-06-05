import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cleanupLocalConfigAfterSuccessfulPush } from '../src/core/configLifecycle.js';
import { runCommand } from '../src/core/executor.js';
import { getCurrentBranch, prepareCleanBase, pushBridgeBranch } from '../src/core/git.js';

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Bridge Test',
  GIT_AUTHOR_EMAIL: 'bridge@example.test',
  GIT_COMMITTER_NAME: 'Bridge Test',
  GIT_COMMITTER_EMAIL: 'bridge@example.test'
};

async function git(cwd, args, options = {}) {
  return runCommand(`git ${args}`, {
    cwd,
    quiet: true,
    env: gitEnv,
    ...options
  });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-safety-'));

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  return tempDir;
}

async function createRepoWithOrigin(t, { defaultBranch = 'master' } = {}) {
  const root = await makeTempDir(t);
  const originDir = path.join(root, 'origin.git');
  const repoDir = path.join(root, 'repo');

  await git(root, `init --bare --initial-branch=${defaultBranch} origin.git`);
  await fs.mkdir(repoDir);
  await git(repoDir, `init --initial-branch=${defaultBranch}`);
  await git(repoDir, 'config user.name "Bridge Test"');
  await git(repoDir, 'config user.email bridge@example.test');
  await git(repoDir, 'remote add origin ../origin.git');
  await fs.writeFile(path.join(repoDir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  await git(repoDir, 'add package.json');
  await git(repoDir, 'commit -m initial');
  await git(repoDir, `push -u origin ${defaultBranch}`);
  await git(originDir, `symbolic-ref HEAD refs/heads/${defaultBranch}`);

  return {
    root,
    originDir,
    repoDir,
    defaultBranch
  };
}

async function createLocalRepo(t, { defaultBranch = 'main' } = {}) {
  const root = await makeTempDir(t);

  await git(root, `init --initial-branch=${defaultBranch}`);
  await git(root, 'config user.name "Bridge Test"');
  await git(root, 'config user.email bridge@example.test');
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  await git(root, 'add package.json');
  await git(root, 'commit -m initial');

  return root;
}

test('prepareCleanBase pulls master and creates the Bridge branch before updates', async (t) => {
  const { repoDir } = await createRepoWithOrigin(t, { defaultBranch: 'master' });

  await git(repoDir, 'checkout -b local-work');
  await fs.writeFile(path.join(repoDir, 'local.txt'), 'local-only\n', 'utf8');
  await git(repoDir, 'add local.txt');
  await git(repoDir, 'commit -m "local branch work"');

  const result = await prepareCleanBase(repoDir, {
    configuredDefaultBranch: 'master',
    protectedBranches: [],
    branchPrefix: 'bridge/patch',
    dateStamp: '2026-06-05'
  });

  assert.equal(result.branch, 'master');
  assert.equal(result.branchName, 'bridge/patch-2026-06-05');
  assert.equal(await getCurrentBranch(repoDir), 'bridge/patch-2026-06-05');

  const branches = await git(repoDir, 'branch --format="%(refname:short)"');
  assert.deepEqual(
    branches.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort(),
    ['bridge/patch-2026-06-05', 'master']
  );
});

test('prepareCleanBase detects origin default branch when config omits it', async (t) => {
  const { repoDir } = await createRepoWithOrigin(t, { defaultBranch: 'master' });

  const result = await prepareCleanBase(repoDir, {
    configuredDefaultBranch: '',
    protectedBranches: [],
    branchPrefix: 'bridge/patch',
    dateStamp: '2026-06-05'
  });

  assert.equal(result.branch, 'master');
  assert.equal(result.detectedDefaultBranch, true);
  assert.equal(await getCurrentBranch(repoDir), 'bridge/patch-2026-06-05');
});

test('pushBridgeBranch aborts when current branch is the default branch', async (t) => {
  const { repoDir } = await createRepoWithOrigin(t, { defaultBranch: 'master' });

  await assert.rejects(
    () =>
      pushBridgeBranch(repoDir, {
        branchName: 'bridge/patch-forced',
        defaultBranch: 'master',
        protectedBranches: []
      }),
    /expected Bridge branch "bridge\/patch-forced".*current branch is "master"/
  );

  const remoteBranch = await git(repoDir, 'ls-remote --heads origin bridge/patch-forced');
  assert.equal(remoteBranch.stdout.trim(), '');
});

test('cleanupLocalConfigAfterSuccessfulPush removes an untracked first-init config', async (t) => {
  const repoDir = await createLocalRepo(t);
  const configPath = path.join(repoDir, 'bridge.config.json');

  await fs.writeFile(configPath, '{"packageManager":"npm"}\n', 'utf8');
  const result = await cleanupLocalConfigAfterSuccessfulPush(repoDir, 'bridge.config.json');

  assert.equal(result.removed, true);
  assert.equal(await pathExists(configPath), false);
});

test('cleanupLocalConfigAfterSuccessfulPush keeps a tracked config', async (t) => {
  const repoDir = await createLocalRepo(t);
  const configPath = path.join(repoDir, 'bridge.config.json');

  await fs.writeFile(configPath, '{"packageManager":"npm"}\n', 'utf8');
  await git(repoDir, 'add bridge.config.json');
  await git(repoDir, 'commit -m "track bridge config"');

  const result = await cleanupLocalConfigAfterSuccessfulPush(repoDir, 'bridge.config.json');

  assert.equal(result.removed, false);
  assert.equal(result.reason, 'tracked_or_history');
  assert.equal(await pathExists(configPath), true);
});

test('cleanupLocalConfigAfterSuccessfulPush keeps a config path that appears in history', async (t) => {
  const repoDir = await createLocalRepo(t);
  const configPath = path.join(repoDir, 'bridge.config.json');

  await fs.writeFile(configPath, '{"packageManager":"npm"}\n', 'utf8');
  await git(repoDir, 'add bridge.config.json');
  await git(repoDir, 'commit -m "track bridge config"');
  await fs.rm(configPath);
  await git(repoDir, 'add -A');
  await git(repoDir, 'commit -m "remove bridge config"');
  await fs.writeFile(configPath, '{"packageManager":"npm"}\n', 'utf8');

  const result = await cleanupLocalConfigAfterSuccessfulPush(repoDir, 'bridge.config.json');

  assert.equal(result.removed, false);
  assert.equal(result.reason, 'tracked_or_history');
  assert.equal(await pathExists(configPath), true);
});
