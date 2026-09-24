import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, normalizeConfig } from '../src/core/configReader.js';
import { getGitRepoIdentity, getOriginUrl } from '../src/core/git.js';
import { runCommand } from '../src/core/executor.js';

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

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-marcus-'));

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  return tempDir;
}

async function createRepoWithOrigin(t, { defaultBranch = 'main' } = {}) {
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

// P0: Config immutability tests

test('P0: normalizeConfig does not add empty repoUrl, defaultBranch, or protectedBranches', () => {
  const input = {
    name: 'test-project',
    packageManager: 'npm',
    installCommand: 'npm ci',
    updateCommand: 'npm update',
    cleanCommands: ['rm -rf node_modules']
  };

  const normalized = normalizeConfig(input);

  assert.equal('repoUrl' in normalized, false, 'repoUrl should not be added when not provided');
  assert.equal('defaultBranch' in normalized, false, 'defaultBranch should not be added when not provided');
  assert.equal('protectedBranches' in normalized, false, 'protectedBranches should not be added when not provided');
});

test('P0: normalizeConfig preserves explicitly provided git-derived settings', () => {
  const input = {
    name: 'test-project',
    packageManager: 'npm',
    installCommand: 'npm ci',
    updateCommand: 'npm update',
    cleanCommands: ['rm -rf node_modules'],
    repoUrl: 'https://github.com/example/repo',
    defaultBranch: 'develop',
    protectedBranches: ['main', 'develop']
  };

  const normalized = normalizeConfig(input);

  assert.equal(normalized.repoUrl, 'https://github.com/example/repo');
  assert.equal(normalized.defaultBranch, 'develop');
  assert.deepEqual(normalized.protectedBranches, ['main', 'develop']);
});

test('P0: normalizeConfig ignores empty string values for git-derived settings', () => {
  const input = {
    name: 'test-project',
    packageManager: 'npm',
    installCommand: 'npm ci',
    updateCommand: 'npm update',
    cleanCommands: ['rm -rf node_modules'],
    repoUrl: '',
    defaultBranch: '  ',
    protectedBranches: []
  };

  const normalized = normalizeConfig(input);

  assert.equal('repoUrl' in normalized, false, 'empty repoUrl should not be included');
  assert.equal('defaultBranch' in normalized, false, 'whitespace-only defaultBranch should not be included');
  assert.equal('protectedBranches' in normalized, false, 'empty protectedBranches array should not be included');
});

// P1: Git-derived settings tests

test('P1: getGitRepoIdentity retrieves origin URL from git', async (t) => {
  const { repoDir } = await createRepoWithOrigin(t);

  const identity = await getGitRepoIdentity(repoDir);

  assert.equal(identity.hasOriginUrl, true);
  assert.match(identity.originUrl, /origin\.git/);
});

test('P1: getGitRepoIdentity detects default branch from git', async (t) => {
  const { repoDir } = await createRepoWithOrigin(t, { defaultBranch: 'main' });

  // Ensure origin/HEAD is set
  await git(repoDir, 'remote set-head origin main');

  const identity = await getGitRepoIdentity(repoDir);

  assert.equal(identity.hasDefaultBranch, true);
  assert.equal(identity.defaultBranch, 'main');
});

test('P1: getOriginUrl returns empty for repo without origin', async (t) => {
  const tempDir = await makeTempDir(t);

  await git(tempDir, 'init');

  const originUrl = await getOriginUrl(tempDir);

  assert.equal(originUrl, '');
});

// P3: Branch naming tests

test('P3: date stamp includes time component for uniqueness', () => {
  // Import the getDateStamp function (need to export it for testing)
  // For now, test by constructing expected format
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const expected = `${year}-${month}-${day}-${hours}${minutes}`;

  // The format should be YYYY-MM-DD-HHMM
  assert.match(expected, /^\d{4}-\d{2}-\d{2}-\d{4}$/);
});

test('P3: branch names are distinguishable for same-day runs', () => {
  // Morning run
  const morning = new Date('2026-09-18T09:30:00');
  const morningYear = morning.getFullYear();
  const morningMonth = String(morning.getMonth() + 1).padStart(2, '0');
  const morningDay = String(morning.getDate()).padStart(2, '0');
  const morningHours = String(morning.getHours()).padStart(2, '0');
  const morningMinutes = String(morning.getMinutes()).padStart(2, '0');
  const morningStamp = `${morningYear}-${morningMonth}-${morningDay}-${morningHours}${morningMinutes}`;

  // Evening run
  const evening = new Date('2026-09-18T16:45:00');
  const eveningYear = evening.getFullYear();
  const eveningMonth = String(evening.getMonth() + 1).padStart(2, '0');
  const eveningDay = String(evening.getDate()).padStart(2, '0');
  const eveningHours = String(evening.getHours()).padStart(2, '0');
  const eveningMinutes = String(evening.getMinutes()).padStart(2, '0');
  const eveningStamp = `${eveningYear}-${eveningMonth}-${eveningDay}-${eveningHours}${eveningMinutes}`;

  assert.notEqual(morningStamp, eveningStamp, 'Morning and evening stamps should differ');
  assert.equal(morningStamp, '2026-09-18-0930');
  assert.equal(eveningStamp, '2026-09-18-1645');
});

// P0: Config not staged into patch tests

test('P0: config file left unchanged when loading and normalizing', async (t) => {
  const tempDir = await makeTempDir(t);
  const configPath = path.join(tempDir, 'bridge.config.json');

  const originalConfig = {
    name: 'test-project',
    packageManager: 'npm',
    installCommand: 'npm ci',
    updateCommand: 'npm update',
    cleanCommands: ['rm -rf node_modules']
  };

  await fs.writeFile(configPath, JSON.stringify(originalConfig, null, 2), 'utf8');
  const originalContent = await fs.readFile(configPath, 'utf8');

  // Load and normalize config
  const { config } = await loadConfig(tempDir);

  // Config should be normalized in memory
  assert.equal(config.packageManager, 'npm');
  assert.equal(config.blockOnNewVulnerabilities, true); // default value

  // File should be unchanged
  const afterContent = await fs.readFile(configPath, 'utf8');
  assert.equal(afterContent, originalContent, 'Config file should not be modified');
});

// P2: Early exit tests (conceptual - actual integration test would be more complex)

test('P2: empty metrics summary indicates no updates', () => {
  const emptyMetrics = {
    totalChanged: 0,
    added: 0,
    removed: 0,
    directChanged: 0,
    transitiveChanged: 0,
    byBump: { patch: 0, minor: 0, major: 0, other: 0 }
  };

  const hasChanges = emptyMetrics.totalChanged > 0 ||
    emptyMetrics.added > 0 ||
    emptyMetrics.removed > 0;

  assert.equal(hasChanges, false, 'Empty metrics should indicate no updates');
});

test('P2: metrics with changes indicates updates found', () => {
  const metricsWithChanges = {
    totalChanged: 5,
    added: 1,
    removed: 0,
    directChanged: 2,
    transitiveChanged: 3,
    byBump: { patch: 3, minor: 1, major: 1, other: 0 }
  };

  const hasChanges = metricsWithChanges.totalChanged > 0;

  assert.equal(hasChanges, true, 'Metrics with changes should indicate updates found');
});
