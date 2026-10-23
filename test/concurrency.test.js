import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getDailyWrapperPath, runScheduledRepos, runWithConcurrency } from '../src/core/batchRunner.js';
import { logActivity, makeRunContext } from '../src/core/activityLogger.js';
import { getActivityLogPath } from '../src/core/activityLogger.js';
import { runCommand } from '../src/core/executor.js';
import { applyRetention } from '../src/core/retention.js';

const wrapperPath = getDailyWrapperPath();
const cliPath = new URL('../bin/bridge.js', import.meta.url).pathname;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Bridge Test',
  GIT_AUTHOR_EMAIL: 'bridge@example.test',
  GIT_COMMITTER_NAME: 'Bridge Test',
  GIT_COMMITTER_EMAIL: 'bridge@example.test'
};

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-concurrency-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function git(cwd, args) {
  return runCommand(`git ${args}`, { cwd, quiet: true, env: gitEnv });
}

async function createOriginRepo(t, name) {
  const root = await makeTempDir(t);
  const originDir = path.join(root, `${name}.git`);
  const seedDir = path.join(root, 'seed');
  await runCommand(`git init --bare --initial-branch=main ${JSON.stringify(originDir)}`, {
    cwd: root,
    quiet: true,
    env: gitEnv
  });
  await fs.mkdir(seedDir);
  await git(seedDir, 'init --initial-branch=main');
  await git(seedDir, 'config user.name "Bridge Test"');
  await git(seedDir, 'config user.email bridge@example.test');
  await git(seedDir, `remote add origin ${JSON.stringify(originDir)}`);
  await fs.writeFile(path.join(seedDir, 'README.md'), `${name}\n`, 'utf8');
  await git(seedDir, 'add README.md');
  await git(seedDir, 'commit -m initial');
  await git(seedDir, 'push -u origin main');
  return { root, originDir };
}

async function writeFakeBridge(binDir, { runIdPrefix = 'patch-this' } = {}) {
  const fake = path.join(binDir, 'bridge');
  await fs.writeFile(
    fake,
    `#!/usr/bin/env bash
set -euo pipefail
echo "fake-bridge $*"
run_id="${runIdPrefix}-$$-$RANDOM"
run_dir="\${BRIDGE_HOME}/runs/\${run_id}"
mkdir -p "$run_dir/scripts"
cat > "$run_dir/bridge-summary.md" <<'EOF'
# Bridge after-script summary
CONCURRENT
EOF
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$run_dir/bridge-report.v1.json" <<EOF
{"run":{"id":"$run_id","status":"dry_run","startedAt":"$started_at","durationMs":12},"target":{"repository":"${runIdPrefix}"},"outcome":{"dependencySummary":{"totalChanged":1,"directChanged":1,"transitiveChanged":0},"scriptSummary":{"scripts":[{"name":"npm test","result":"pass","durationMs":5}]},"pullRequest":null}}
EOF
echo "Summary file: $run_dir/bridge-summary.md"
echo "Report: $run_dir/bridge-report.v1.json"
exit 0
`,
    { mode: 0o755 }
  );
  return fake;
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
      '': { name: 'fixture', dependencies: { example: '^1.0.0' } },
      'node_modules/example': { version }
    }
  };
}

async function writePatchFixture(originDir, name) {
  const checkout = path.join(path.dirname(originDir), `${name}-seed-checkout`);
  await runCommand(`git clone ${quote(originDir)} ${quote(checkout)}`, {
    cwd: path.dirname(originDir),
    quiet: true,
    env: gitEnv
  });
  await git(checkout, 'config user.name "Bridge Test"');
  await git(checkout, 'config user.email bridge@example.test');
  const config = {
    name,
    packageManager: 'npm',
    installCommand: 'node -e "process.exit(0)"',
    updateCommand:
      'node -e "const fs=require(\'fs\');const p=JSON.parse(fs.readFileSync(\'package-lock.json\',\'utf8\'));p.packages[\'node_modules/example\'].version=\'1.0.1\';fs.writeFileSync(\'package-lock.json\',JSON.stringify(p,null,2)+\'\\\\n\')"',
    cleanCommands: ['rm -f package-lock.json'],
    beforeScripts: ['node -e "process.exit(0)"'],
    afterScripts: [
      'node -e "const p=require(\'./package-lock.json\'); if (p.packages[\'node_modules/example\'].version !== \'1.0.1\') process.exit(1)"'
    ],
    auditCommand: `node -e 'console.log(${JSON.stringify(emptyAuditJson())})'`,
    blockOnNewVulnerabilities: true,
    pullRequest: { enabled: false },
    branchPrefix: 'bridge/test',
    defaultBranch: 'main'
  };
  await fs.writeFile(
    path.join(checkout, 'package.json'),
    `${JSON.stringify({ name, dependencies: { example: '^1.0.0' } }, null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(checkout, 'package-lock.json'),
    `${JSON.stringify(packageLock('1.0.0'), null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(checkout, 'bridge.config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8'
  );
  await git(checkout, 'add package.json package-lock.json bridge.config.json');
  await git(checkout, 'commit -m fixture');
  await git(checkout, 'push origin main');
  return checkout;
}

test('runWithConcurrency keeps two workers busy', async () => {
  const seen = [];
  const results = await runWithConcurrency([10, 20, 30], 2, async (value) => {
    seen.push(value);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return value * 2;
  });
  assert.deepEqual(results, [20, 40, 60]);
  assert.equal(seen.length, 3);
});

test('concurrent logActivity writes stay valid JSONL', async (t) => {
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

  const contexts = [makeRunContext('patch', '/tmp/a'), makeRunContext('patch', '/tmp/b')];
  await Promise.all(
    contexts.flatMap((context) =>
      Array.from({ length: 12 }, (_, index) =>
        logActivity('phase', {
          runId: context.runId,
          command: context.command,
          phase: `step-${index}`,
          status: 'success'
        })
      )
    )
  );

  const log = await fs.readFile(getActivityLogPath(), 'utf8');
  const lines = log
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.equal(lines.length, 24);
  const runIds = new Set(lines.map((entry) => entry.runId));
  assert.equal(runIds.size, 2);
  for (const context of contexts) {
    const perRun = await fs.readFile(
      path.join(bridgeHome, 'runs', context.runId, 'operations.jsonl'),
      'utf8'
    );
    assert.equal(perRun.trim().split(/\n/).length, 12);
  }
});

test('two daily wrappers for different repos run concurrently', async (t) => {
  const first = await createOriginRepo(t, 'alpha');
  const second = await createOriginRepo(t, 'beta');
  const bridgeHome = path.join(first.root, 'bridge-home');
  const binDir = path.join(first.root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir);

  const env = {
    ...gitEnv,
    BRIDGE_HOME: bridgeHome,
    PATH: `${binDir}:${process.env.PATH}`,
    BRIDGE_BIN: fakeBridge
  };

  const batch = await runScheduledRepos({
    repos: [{ repo: first.originDir }, { repo: second.originDir }],
    concurrency: 2,
    dryRun: true,
    skipBeforeScripts: true,
    env,
    cwd: first.root,
    wrapperPath,
    bridgeHome
  });

  assert.equal(batch.results.length, 2);
  assert.equal(batch.ok, true, JSON.stringify(batch.results, null, 2));
  assert.notEqual(batch.results[0].runId, batch.results[1].runId);
  assert.ok(batch.performance.wallMs >= 0);
  assert.match(batch.daily.text, /Bridge daily summary/);
  await fs.access(path.join(bridgeHome, 'schedule', 'LATEST.md'));

  const lockDir = path.join(bridgeHome, 'schedule', 'locks');
  const locks = await fs.readdir(lockDir);
  assert.equal(locks.filter((name) => name.endsWith('.lock')).length, 0);
});

test('two real bridge patch dry-runs isolate workspaces, run dirs, and logs', async (t) => {
  const first = await createOriginRepo(t, 'one');
  const second = await createOriginRepo(t, 'two');
  const checkoutOne = await writePatchFixture(first.originDir, 'repo-one');
  const checkoutTwo = await writePatchFixture(second.originDir, 'repo-two');
  const bridgeHome = path.join(first.root, 'shared-home');
  await fs.mkdir(bridgeHome, { recursive: true });

  const env = {
    ...gitEnv,
    BRIDGE_HOME: bridgeHome,
    PATH: process.env.PATH
  };

  const started = Date.now();
  const [left, right] = await Promise.all([
    runCommand(`${quote(process.execPath)} ${quote(cliPath)} patch --dry-run --skip-before-scripts`, {
      cwd: checkoutOne,
      quiet: true,
      allowFailure: true,
      env
    }),
    runCommand(`${quote(process.execPath)} ${quote(cliPath)} patch --dry-run --skip-before-scripts`, {
      cwd: checkoutTwo,
      quiet: true,
      allowFailure: true,
      env
    })
  ]);
  const wallMs = Date.now() - started;

  assert.equal(left.success, true, `${left.stdout}\n${left.stderr}`);
  assert.equal(right.success, true, `${right.stdout}\n${right.stderr}`);
  assert.match(left.stdout, /Isolated workspace:/);
  assert.match(right.stdout, /Isolated workspace:/);

  const leftWorkspace = left.stdout.match(/Isolated workspace: (\S+)/)[1];
  const rightWorkspace = right.stdout.match(/Isolated workspace: (\S+)/)[1];
  assert.notEqual(leftWorkspace, rightWorkspace);

  const runs = await fs.readdir(path.join(bridgeHome, 'runs'));
  assert.ok(runs.length >= 2);
  const reports = [];
  for (const id of runs) {
    const reportPath = path.join(bridgeHome, 'runs', id, 'bridge-report.v1.json');
    try {
      reports.push(JSON.parse(await fs.readFile(reportPath, 'utf8')));
    } catch {
      // ignore partial
    }
  }
  const repos = new Set(reports.map((report) => report.target?.repository));
  assert.ok(repos.has('repo-one'));
  assert.ok(repos.has('repo-two'));
  for (const report of reports) {
    assert.ok(report.timeSaved);
    assert.equal(typeof report.timeSaved.durationMs, 'number');
    assert.ok(report.performance);
    assert.match(report.timeSaved.schemaVersion, /time-saved/);
  }

  const log = await fs.readFile(path.join(bridgeHome, 'logs', 'operations.log'), 'utf8');
  for (const line of log.split(/\n/).filter(Boolean)) {
    JSON.parse(line);
  }

  assert.ok(wallMs >= 0);
  await applyRetention({
    bridgeHome,
    settings: { retention: { maxAgeDays: 30, maxRuns: 100, maxLogBytes: 1024 * 1024 } },
    keepRunIds: runs
  });
});
