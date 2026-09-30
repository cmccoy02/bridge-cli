import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCommand } from '../src/core/executor.js';
import { describeScriptLifecycleOrder } from '../src/core/scriptLifecycle.js';

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

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-lifecycle-'));

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

function emptyAuditJson() {
  return JSON.stringify({
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
}

function packageLock(version) {
  return {
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
        version
      }
    }
  };
}

async function writePatchFixture(repoDir, { defaultBranch, beforeScripts, afterScripts }) {
  const config = {
    name: 'script-lifecycle-fixture',
    packageManager: 'npm',
    installCommand: 'node -e "process.exit(0)"',
    updateCommand:
      'node -e "const fs=require(\'fs\');const p=JSON.parse(fs.readFileSync(\'package-lock.json\',\'utf8\'));p.packages[\'node_modules/example\'].version=\'1.0.1\';fs.writeFileSync(\'package-lock.json\',JSON.stringify(p,null,2)+\'\\\\n\')"',
    cleanCommands: ['rm -f package-lock.json'],
    beforeScripts,
    afterScripts,
    auditCommand: `node -e 'console.log(${JSON.stringify(emptyAuditJson())})'`,
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

  await fs.writeFile(
    path.join(repoDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(repoDir, 'package-lock.json'),
    `${JSON.stringify(packageLock('1.0.0'), null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(repoDir, 'bridge.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8'
  );
  await git(repoDir, 'add package.json package-lock.json bridge.config.json');
  await git(repoDir, 'commit -m "add script lifecycle fixture"');
  await git(repoDir, `push origin ${defaultBranch}`);
}

async function runPatch(repoDir, bridgeHome) {
  return runCommand(`${quote(process.execPath)} ${quote(cliPath)} patch`, {
    cwd: repoDir,
    quiet: true,
    allowFailure: true,
    env: {
      ...gitEnv,
      BRIDGE_HOME: bridgeHome
    }
  });
}

async function readActivityPhases(bridgeHome) {
  const logPath = path.join(bridgeHome, 'logs', 'operations.log');
  const text = await fs.readFile(logPath, 'utf8');

  return text
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.event === 'phase' && entry.phase)
    .map((entry) => entry.phase);
}

async function listRemoteBridgeBranches(repoDir) {
  const remote = await git(repoDir, 'ls-remote --heads origin bridge/test-*');
  return remote.stdout.trim();
}

test('patch runs beforeScripts on the baseline before update, then afterScripts', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t);
  const bridgeHome = await makeTempDir(t);

  await writePatchFixture(repoDir, {
    defaultBranch,
    beforeScripts: [
      'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\'].version !== \'1.0.0\') process.exit(1)"'
    ],
    afterScripts: [
      'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\'].version !== \'1.0.1\') process.exit(1)"'
    ]
  });

  const result = await runPatch(repoDir, bridgeHome);
  const phases = await readActivityPhases(bridgeHome);
  const order = describeScriptLifecycleOrder(phases);

  assert.equal(result.success, true, result.stderr || result.stdout);
  assert.ok(order.beforeScriptsRunOnBaseline, JSON.stringify(order.phases));
  assert.ok(order.afterScriptsRunOnCandidate, JSON.stringify(order.phases));
  assert.match(await listRemoteBridgeBranches(repoDir), /refs\/heads\/bridge\/test-/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /persist \(not blocking\)/);
});

test('new after-script failures hard-stop before push/PR', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t);
  const bridgeHome = await makeTempDir(t);

  await writePatchFixture(repoDir, {
    defaultBranch,
    beforeScripts: [
      'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\'].version !== \'1.0.0\') process.exit(1)"'
    ],
    afterScripts: ['node -e "process.exit(1)"']
  });

  const result = await runPatch(repoDir, bridgeHome);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.success, false);
  assert.match(output, /NEW after-script failure introduced by the update/);
  assert.match(output, /Stopping before push\/PR/);
  assert.match(output, /stopped before push\/PR/);
  assert.equal(await listRemoteBridgeBranches(repoDir), '');
});

test('pre-existing baseline failures do not block push and are not called persist-not-blocking', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t);
  const bridgeHome = await makeTempDir(t);
  const failingScript =
    'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\']) process.exit(1)"';

  await writePatchFixture(repoDir, {
    defaultBranch,
    beforeScripts: [failingScript],
    afterScripts: [failingScript]
  });

  const result = await runPatch(repoDir, bridgeHome);
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.success, true, output);
  assert.match(output, /pre-existing baseline script failure/);
  assert.match(output, /do not block push\/PR/);
  assert.doesNotMatch(output, /persist \(not blocking\)/);
  assert.match(await listRemoteBridgeBranches(repoDir), /refs\/heads\/bridge\/test-/);
});
