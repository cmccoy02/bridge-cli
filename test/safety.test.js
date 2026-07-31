import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cleanupLocalConfigAfterSuccessfulPush } from '../src/core/configLifecycle.js';
import { runCommand } from '../src/core/executor.js';
import { getCurrentBranch, prepareCleanBase, pushBridgeBranch } from '../src/core/git.js';

const cliPath = new URL('../bin/bridge.js', import.meta.url).pathname;

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

function quote(value) {
  return `'${String(value).replace(/'/g, `"'"'`)}'`;
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

test('patch defaults to a candidate-branch push without touching the local branch', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t, {
    defaultBranch: 'main'
  });
  const originalHead = (await git(repoDir, 'rev-parse HEAD')).stdout.trim();
  const auditJson = JSON.stringify({
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0
      }
    }
  });
  const config = {
    name: 'dry-run-fixture',
    packageManager: 'npm',
    installCommand: 'node -e "process.exit(0)"',
    updateCommand:
      'node -e "const fs=require(\'fs\');const p=JSON.parse(fs.readFileSync(\'package-lock.json\',\'utf8\'));p.packages[\'node_modules/example\'].version=\'1.0.1\';fs.writeFileSync(\'package-lock.json\',JSON.stringify(p,null,2)+\'\\\\n\')"',
    cleanCommands: [],
    beforeScripts: ['node -e "process.exit(0)"'],
    afterScripts: ['node -e "process.exit(0)"'],
    auditCommand: `node -e 'console.log(${JSON.stringify(auditJson)})'`,
    blockOnNewVulnerabilities: true,
    branchPrefix: 'bridge/test',
    defaultBranch
  };
  const packageJson = {
    name: 'fixture',
    dependencies: {
      example: '^1.0.0'
    }
  };
  const packageLock = {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'fixture',
        dependencies: {
          example: '^1.0.0'
        }
      },
      'node_modules/example': {
        version: '1.0.0'
      }
    }
  };

  await fs.writeFile(
    path.join(repoDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(repoDir, 'package-lock.json'),
    `${JSON.stringify(packageLock, null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(repoDir, 'bridge.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8'
  );
  await git(repoDir, 'add package.json package-lock.json bridge.config.json');
  await git(repoDir, 'commit -m "add bridge dry-run fixture"');
  await git(repoDir, 'push origin main');
  const headBeforeDryRun = (await git(repoDir, 'rev-parse HEAD')).stdout.trim();

  assert.notEqual(headBeforeDryRun, originalHead);
  const result = await runCommand(
    `${quote(process.execPath)} ${quote(cliPath)} patch`,
    {
      cwd: repoDir,
      quiet: true,
      env: gitEnv
    }
  );
  assert.equal(result.success, true);
  assert.equal((await git(repoDir, 'rev-parse HEAD')).stdout.trim(), headBeforeDryRun);
  assert.equal(await getCurrentBranch(repoDir), 'main');

  const remoteBridgeBranches = await git(repoDir, 'ls-remote --heads origin bridge/test-*');
  assert.match(remoteBridgeBranches.stdout, /refs\/heads\/bridge\/test-/);
});
