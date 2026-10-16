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

async function writePatchFixture(
  repoDir,
  { defaultBranch, beforeScripts, afterScripts, extraConfig = {} }
) {
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
    defaultBranch,
    ...extraConfig
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

async function runPatch(repoDir, bridgeHome, extraArgs = '') {
  return runCommand(
    `${quote(process.execPath)} ${quote(cliPath)} patch${extraArgs ? ` ${extraArgs}` : ''}`,
    {
      cwd: repoDir,
      quiet: true,
      allowFailure: true,
      env: {
        ...gitEnv,
        BRIDGE_HOME: bridgeHome
      }
    }
  );
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
    afterScripts: [
      'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\'].version !== \'1.0.0\') process.exit(1)"'
    ]
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

test('end-of-run summary table is printed and written to the run folder', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t);
  const bridgeHome = await makeTempDir(t);

  await writePatchFixture(repoDir, {
    defaultBranch,
    beforeScripts: [
      'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\'].version !== \'1.0.0\') process.exit(1)"'
    ],
    afterScripts: [
      'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\'].version !== \'1.0.1\') process.exit(1)"',
      'node -e "process.exit(0)"'
    ]
  });

  const result = await runPatch(repoDir, bridgeHome);
  const output = `${result.stdout}\n${result.stderr}`;
  const runsDir = path.join(bridgeHome, 'runs');
  const runDirs = (await fs.readdir(runsDir)).filter((name) => name.startsWith('patch-'));
  const report = JSON.parse(
    await fs.readFile(path.join(runsDir, runDirs[0], 'bridge-report.v1.json'), 'utf8')
  );
  const summary = await fs.readFile(
    path.join(runsDir, runDirs[0], 'bridge-summary.md'),
    'utf8'
  );
  const scriptLogs = await fs.readdir(path.join(runsDir, runDirs[0], 'scripts'));

  assert.equal(result.success, true, output);
  assert.match(output, /After-script summary/);
  assert.match(output, /Result/);
  assert.match(output, /Failure/);
  assert.equal(report.outcome.scriptSummary.scripts.length, 2);
  assert.equal(report.outcome.scriptSummary.scripts[0].result, 'pass');
  assert.ok(report.outcome.scriptSummary.scripts[0].logPath);
  assert.match(summary, /# Bridge after-script summary/);
  assert.ok(scriptLogs.length >= 2);
});

test('skipBeforeScripts does not run beforeScripts and still compares afterScripts to baseline', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t);
  const bridgeHome = await makeTempDir(t);

  await writePatchFixture(repoDir, {
    defaultBranch,
    beforeScripts: ['node -e "throw new Error(\'before-script-should-not-run\')"'],
    afterScripts: [
      'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\'].version !== \'1.0.1\') process.exit(1)"'
    ],
    extraConfig: { skipBeforeScripts: true }
  });

  const result = await runPatch(repoDir, bridgeHome, '--skip-before-scripts');
  const output = `${result.stdout}\n${result.stderr}`;
  const phases = await readActivityPhases(bridgeHome);
  const log = await fs.readFile(path.join(bridgeHome, 'logs', 'operations.log'), 'utf8');

  assert.equal(result.success, true, output);
  assert.doesNotMatch(output, /before-script-should-not-run/);
  assert.match(log, /"reason":"skipBeforeScripts"/);
  assert.ok(phases.some((phase) => phase.startsWith('beforeScripts')));
  assert.ok(phases.some((phase) => phase.startsWith('baselineScripts')));
  assert.ok(phases.some((phase) => phase.startsWith('afterScripts')));
  assert.match(output, /skipBeforeScripts is on/);
  assert.match(output, /After-script summary/);
});

test('skipBeforeScripts still treats pre-existing after-script failures as baseline', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t);
  const bridgeHome = await makeTempDir(t);
  const failingScript =
    'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\']) process.exit(1)"';

  await writePatchFixture(repoDir, {
    defaultBranch,
    beforeScripts: ['node -e "process.exit(0)"'],
    afterScripts: [failingScript],
    extraConfig: { skipBeforeScripts: true }
  });

  const result = await runPatch(repoDir, bridgeHome, '--skip-before-scripts');
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.success, true, output);
  assert.match(output, /already present/);
  assert.doesNotMatch(output, /NEW after-script failure introduced by the update/);
  assert.match(await listRemoteBridgeBranches(repoDir), /refs\/heads\/bridge\/test-/);
});

test('skipBeforeScripts still hard-stops on a new after-script failure', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t);
  const bridgeHome = await makeTempDir(t);

  await writePatchFixture(repoDir, {
    defaultBranch,
    beforeScripts: ['node -e "process.exit(0)"'],
    afterScripts: [
      'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\'].version !== \'1.0.0\') process.exit(1)"'
    ],
    extraConfig: { skipBeforeScripts: true }
  });

  const result = await runPatch(repoDir, bridgeHome, '--skip-before-scripts');
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.success, false);
  assert.match(output, /NEW after-script failure introduced by the update/);
  assert.match(output, /Stopping before push\/PR/);
  assert.equal(await listRemoteBridgeBranches(repoDir), '');
});

test('baseline install happens before script measurement so node_modules exists', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t);
  const bridgeHome = await makeTempDir(t);

  await writePatchFixture(repoDir, {
    defaultBranch,
    beforeScripts: [
      'node -e "const fs=require(\'fs\'); if (!fs.existsSync(\'package-lock.json\')) process.exit(2)"'
    ],
    afterScripts: [
      'node -e "const fs=require(\'fs\'); if (!fs.existsSync(\'package-lock.json\')) process.exit(2)"'
    ],
    extraConfig: {
      cleanCommands: ['rm -rf node_modules', 'rm -f package-lock.json'],
      installCommand:
        'node -e "const fs=require(\'fs\'); fs.mkdirSync(\'node_modules\',{recursive:true}); if (!fs.existsSync(\'package-lock.json\')) process.exit(3)"'
    }
  });

  const result = await runPatch(repoDir, bridgeHome);
  const phases = await readActivityPhases(bridgeHome);
  const order = describeScriptLifecycleOrder(phases);

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
  assert.ok(order.baselineInstallIndex !== -1);
  assert.ok(order.baselineInstallIndex < order.beforeScriptsIndex);
  assert.ok(order.beforeScriptsRunOnBaseline);
});

test('blockOnBaselineFailures stops after the baseline and before the update', async (t) => {
  const { repoDir, defaultBranch } = await createRepoWithOrigin(t);
  const bridgeHome = await makeTempDir(t);
  const failingScript =
    'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\']) process.exit(1)"';

  await writePatchFixture(repoDir, {
    defaultBranch,
    beforeScripts: [failingScript],
    afterScripts: [failingScript],
    extraConfig: { blockOnBaselineFailures: true }
  });

  const result = await runPatch(repoDir, bridgeHome, '--dry-run --block-on-baseline-failures');
  const output = `${result.stdout}\n${result.stderr}`;
  const phases = await readActivityPhases(bridgeHome);

  assert.equal(result.success, false);
  assert.match(output, /blockOnBaselineFailures is enabled/);
  assert.doesNotMatch(output, /Pre-existing failures are not blocking/);
  assert.doesNotMatch(output, /already present before the update; not blocking/);
  assert.ok(phases.some((phase) => phase.startsWith('beforeScripts')));
  assert.equal(
    phases.some((phase) => phase.startsWith('update')),
    false,
    JSON.stringify(phases)
  );
});
