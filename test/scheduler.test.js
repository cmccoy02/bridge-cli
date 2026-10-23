import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCommand } from '../src/core/executor.js';

const wrapperPath = new URL('../scripts/bridge-daily.sh', import.meta.url).pathname;
const cliPath = new URL('../bin/bridge.js', import.meta.url).pathname;
const crontabExamplePath = new URL('../scripts/schedule/crontab.example', import.meta.url)
  .pathname;
const launchdExamplePath = new URL(
  '../scripts/schedule/com.bridge.daily.plist.example',
  import.meta.url
).pathname;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Bridge Test',
  GIT_AUTHOR_EMAIL: 'bridge@example.test',
  GIT_COMMITTER_NAME: 'Bridge Test',
  GIT_COMMITTER_EMAIL: 'bridge@example.test'
};

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-scheduler-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

async function git(cwd, args) {
  return runCommand(`git ${args}`, { cwd, quiet: true, env: gitEnv });
}

async function createOriginRepo(t) {
  const root = await makeTempDir(t);
  const originDir = path.join(root, 'origin.git');
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
  await fs.writeFile(path.join(seedDir, 'README.md'), 'scheduler fixture\n', 'utf8');
  await git(seedDir, 'add README.md');
  await git(seedDir, 'commit -m initial');
  await git(seedDir, 'push -u origin main');
  return { root, originDir };
}

async function createLocalCheckout(t) {
  const { root, originDir } = await createOriginRepo(t);
  const checkout = path.join(root, 'checkout');
  await runCommand(`git clone ${quote(originDir)} ${quote(checkout)}`, {
    cwd: root,
    quiet: true,
    env: gitEnv
  });
  await git(checkout, 'config user.name "Bridge Test"');
  await git(checkout, 'config user.email bridge@example.test');
  return { root, originDir, checkout };
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function writeFakeBridge(
  binDir,
  { exitCode = 0, writeSummary = true, requireConfig = false, runIdPrefix = 'patch-this' } = {}
) {
  const fake = path.join(binDir, 'bridge');
  const script = `#!/usr/bin/env bash
set -euo pipefail
echo "fake-bridge $*"
${
  requireConfig
    ? `if [[ ! -f bridge.config.json && ! -f .bridge.config.json ]]; then
  echo "error: no bridge.config.json in $(pwd)" >&2
  exit 1
fi
`
    : ''
}
if [[ "${writeSummary ? 1 : 0}" -eq 1 ]]; then
  run_id="${runIdPrefix}-$$"
  run_dir="\${BRIDGE_HOME}/runs/\${run_id}"
  mkdir -p "$run_dir/scripts"
  cat > "$run_dir/bridge-summary.md" <<'EOF'
# Bridge after-script summary
THIS_RUN_MARKER
EOF
  echo '{}' > "$run_dir/bridge-report.v1.json"
  echo "Summary file: $run_dir/bridge-summary.md"
  echo "Report: $run_dir/bridge-report.v1.json"
fi
exit ${exitCode}
`;
  await fs.writeFile(fake, script, { mode: 0o755 });
  return fake;
}

async function runWrapper(args, { cwd, env }) {
  return runCommand(`${quote(wrapperPath)} ${args}`, {
    cwd,
    quiet: true,
    allowFailure: true,
    env: { ...gitEnv, ...env }
  });
}

function wrapperEnv(bridgeHome, binDir, fakeBridge) {
  return {
    BRIDGE_HOME: bridgeHome,
    PATH: `${binDir}:${process.env.PATH}`,
    BRIDGE_BIN: fakeBridge
  };
}

async function readLatestSummary(bridgeHome) {
  const summaries = path.join(bridgeHome, 'schedule', 'summaries');
  const found = await fs.readdir(summaries, { recursive: true });
  const summaryRel = found.find((name) => name.endsWith('bridge-summary.md'));
  assert.ok(summaryRel, `no summary under ${summaries}: ${found.join(', ')}`);
  const summaryPath = path.join(summaries, summaryRel);
  const destDir = path.dirname(summaryPath);
  return {
    summaryPath,
    destDir,
    text: await fs.readFile(summaryPath, 'utf8'),
    runId: (await fs.readFile(path.join(destDir, 'run-id.txt'), 'utf8')).trim()
  };
}

test('wrapper help keeps skip-before-scripts on by default', async (t) => {
  const cwd = await makeTempDir(t);
  const result = await runWrapper('--help', { cwd, env: { BRIDGE_HOME: cwd } });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--skip-before-scripts.*default: on/i);
  assert.match(result.stdout, /--notify/);
});

test('wrapper prints usage and exits 3 without --repo', async (t) => {
  const cwd = await makeTempDir(t);
  const result = await runWrapper('', { cwd, env: { BRIDGE_HOME: cwd } });
  assert.equal(result.code, 3);
  assert.match(`${result.stdout}\n${result.stderr}`, /--repo is required/);
});

test('wrapper copies the compact summary and exits 0 on a successful Bridge run', async (t) => {
  const { root, originDir } = await createOriginRepo(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0 });

  const result = await runWrapper(`--repo ${quote(originDir)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Saved summary:/);
  assert.match(result.stdout, /Captured run-id:/);
  const summaries = path.join(bridgeHome, 'schedule', 'summaries');
  const found = await fs.readdir(summaries, { recursive: true });
  assert.ok(found.some((name) => name.endsWith('bridge-summary.md')));
});

test('wrapper exits non-zero when Bridge fails', async (t) => {
  const { root, originDir } = await createOriginRepo(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 1 });

  const result = await runWrapper(`--repo ${quote(originDir)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(result.success, false);
  assert.equal(result.code, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /bridge patch exited 1/);
});

test('wrapper exits 2 when a live lock is held', async (t) => {
  const { root, originDir } = await createOriginRepo(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const repoName = path.basename(originDir).replace(/\.git$/, '');
  const lockdir = path.join(bridgeHome, 'schedule', 'locks', `${repoName}.lock`);
  await fs.mkdir(lockdir, { recursive: true });
  await fs.writeFile(path.join(lockdir, 'pid'), `${process.pid}\n`, 'utf8');

  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0 });

  const result = await runWrapper(`--repo ${quote(originDir)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(result.code, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /another Bridge daily run holds/);
});

test('wrapper reclaims a stale lock and then runs', async (t) => {
  const { root, originDir } = await createOriginRepo(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const repoName = path.basename(originDir).replace(/\.git$/, '');
  const lockdir = path.join(bridgeHome, 'schedule', 'locks', `${repoName}.lock`);
  await fs.mkdir(lockdir, { recursive: true });
  await fs.writeFile(path.join(lockdir, 'pid'), '99999999\n', 'utf8');

  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0 });

  const result = await runWrapper(`--repo ${quote(originDir)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
});

test('wrapper ignores untracked bridge.config.json when checking a local checkout', async (t) => {
  const { root, checkout } = await createLocalCheckout(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0 });
  await fs.writeFile(path.join(checkout, 'bridge.config.json'), '{}\n', 'utf8');

  const result = await runWrapper(`--repo ${quote(checkout)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /dirty worktree/);
});

test('wrapper still refuses a local checkout with non-config dirty files', async (t) => {
  const { root, checkout } = await createLocalCheckout(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0 });
  await fs.writeFile(path.join(checkout, 'bridge.config.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(checkout, 'wip.txt'), 'dirty\n', 'utf8');

  const result = await runWrapper(`--repo ${quote(checkout)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /dirty worktree/);
});

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

async function writeDailyPatchFixture(checkout) {
  const config = {
    name: 'daily-real-cli-fixture',
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
    `${JSON.stringify({ name: 'fixture', dependencies: { example: '^1.0.0' } }, null, 2)}\n`,
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
  await git(checkout, 'commit -m "add daily real-cli fixture"');
  await git(checkout, 'push origin main');
}

async function assertDedicatedClone(checkout, isolated) {
  const gitStat = await fs.lstat(path.join(isolated, '.git'));
  assert.equal(gitStat.isDirectory(), true, 'isolated workdir must be a plain clone, not a linked worktree');

  const isolatedCommon = path.resolve(
    isolated,
    (await git(isolated, 'rev-parse --git-common-dir')).stdout.trim()
  );
  const sourceCommon = path.resolve(
    checkout,
    (await git(checkout, 'rev-parse --git-common-dir')).stdout.trim()
  );
  assert.notEqual(isolatedCommon, sourceCommon);

  const worktrees = (await git(checkout, 'worktree list --porcelain')).stdout;
  assert.doesNotMatch(worktrees, new RegExp(isolated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch((await git(checkout, 'branch --list')).stdout, /bridge\//);
}

test('wrapper does not change the developer checkout branch', async (t) => {
  const { root, checkout } = await createLocalCheckout(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0, requireConfig: true });

  await git(checkout, 'checkout -b feature');
  await fs.writeFile(path.join(checkout, 'bridge.config.json'), '{"name":"local"}\n', 'utf8');
  const before = (await git(checkout, 'rev-parse --abbrev-ref HEAD')).stdout.trim();
  assert.equal(before, 'feature');

  const result = await runWrapper(`--repo ${quote(checkout)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
  const after = (await git(checkout, 'rev-parse --abbrev-ref HEAD')).stdout.trim();
  assert.equal(after, 'feature');
  const isolated = path.join(bridgeHome, 'schedule', 'repos', 'checkout');
  const isolatedHead = (await git(isolated, 'rev-parse --abbrev-ref HEAD')).stdout.trim();
  assert.equal(isolatedHead, 'HEAD');
  await fs.access(path.join(isolated, 'bridge.config.json'));
  await assertDedicatedClone(checkout, isolated);
});

test('wrapper local --dry-run uses the real Bridge CLI on a dedicated clone', async (t) => {
  const { root, checkout } = await createLocalCheckout(t);
  const bridgeHome = path.join(root, 'bridge-home');
  await writeDailyPatchFixture(checkout);

  const branchesBefore = (await git(checkout, 'branch --list')).stdout;
  const worktreesBefore = (await git(checkout, 'worktree list --porcelain')).stdout;
  const realBridge = `${process.execPath} ${cliPath}`;

  const result = await runWrapper(
    `--repo ${quote(checkout)} --branch main --dry-run --bridge ${quote(realBridge)}`,
    {
      cwd: root,
      env: {
        BRIDGE_HOME: bridgeHome,
        PATH: process.env.PATH
      }
    }
  );

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /dry run/i);
  assert.match(result.stdout, /Saved summary:|Captured run-id:/);

  const isolated = path.join(bridgeHome, 'schedule', 'repos', 'checkout');
  await assertDedicatedClone(checkout, isolated);
  assert.equal((await git(checkout, 'rev-parse --abbrev-ref HEAD')).stdout.trim(), 'main');
  assert.equal((await git(checkout, 'branch --list')).stdout, branchesBefore);
  assert.equal((await git(checkout, 'worktree list --porcelain')).stdout, worktreesBefore);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /already used by worktree/);
});

test('wrapper copies this run-id summary instead of the newest file on disk', async (t) => {
  const { root, originDir } = await createOriginRepo(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0, runIdPrefix: 'patch-this' });

  const otherDir = path.join(bridgeHome, 'runs', 'patch-other-newer');
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(path.join(otherDir, 'bridge-summary.md'), 'CONCURRENT_OTHER_RUN\n', 'utf8');
  const future = new Date('2030-01-01T00:00:00Z');
  await fs.utimes(path.join(otherDir, 'bridge-summary.md'), future, future);

  const result = await runWrapper(`--repo ${quote(originDir)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
  const saved = await readLatestSummary(bridgeHome);
  assert.match(saved.text, /THIS_RUN_MARKER/);
  assert.doesNotMatch(saved.text, /CONCURRENT_OTHER_RUN/);
  assert.match(saved.runId, /^patch-this-/);
  assert.match(result.stdout, new RegExp(`Captured run-id: ${saved.runId}`));
});

test('wrapper re-copies the checkout config instead of a leftover --config copy', async (t) => {
  const { root, checkout } = await createLocalCheckout(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0, requireConfig: true });
  const staleConfig = path.join(root, 'stale.config.json');
  await fs.writeFile(staleConfig, '{"name":"stale-flag"}\n', 'utf8');
  await fs.writeFile(path.join(checkout, 'bridge.config.json'), '{"name":"first-checkout"}\n', 'utf8');

  const first = await runWrapper(
    `--repo ${quote(checkout)} --branch main --config ${quote(staleConfig)}`,
    {
      cwd: root,
      env: wrapperEnv(bridgeHome, binDir, fakeBridge)
    }
  );

  assert.equal(first.success, true, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /Installed config:/);
  assert.match(first.stdout, /Using config: .*stale\.config\.json \(sha256:[0-9a-f]{64}\)/);

  await fs.writeFile(path.join(checkout, 'bridge.config.json'), '{"name":"current-checkout"}\n', 'utf8');

  const second = await runWrapper(`--repo ${quote(checkout)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(second.success, true, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /Using config: .*bridge\.config\.json \(sha256:[0-9a-f]{64}\)/);
  const isolated = await fs.readFile(
    path.join(bridgeHome, 'schedule', 'repos', 'checkout', 'bridge.config.json'),
    'utf8'
  );
  assert.match(isolated, /current-checkout/);
  assert.doesNotMatch(isolated, /stale-flag/);
});

test('wrapper copies --config into a fresh URL clone', async (t) => {
  const { root, originDir } = await createOriginRepo(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0, requireConfig: true });
  const configPath = path.join(root, 'provided.config.json');
  await fs.writeFile(configPath, '{"name":"from-flag"}\n', 'utf8');

  const result = await runWrapper(
    `--repo ${quote(originDir)} --branch main --config ${quote(configPath)}`,
    {
      cwd: root,
      env: wrapperEnv(bridgeHome, binDir, fakeBridge)
    }
  );

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Installed config:/);
  assert.match(result.stdout, /Using config: .*provided\.config\.json \(sha256:[0-9a-f]{64}\)/);
  const repoName = path.basename(originDir).replace(/\.git$/, '');
  const installed = await fs.readFile(
    path.join(bridgeHome, 'schedule', 'repos', repoName, 'bridge.config.json'),
    'utf8'
  );
  assert.match(installed, /from-flag/);
});

test('wrapper copies config from the known schedule/configs location', async (t) => {
  const { root, originDir } = await createOriginRepo(t);
  const bridgeHome = path.join(root, 'bridge-home');
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, { exitCode: 0, requireConfig: true });
  const repoName = path.basename(originDir).replace(/\.git$/, '');
  const knownDir = path.join(bridgeHome, 'schedule', 'configs', repoName);
  await fs.mkdir(knownDir, { recursive: true });
  await fs.writeFile(path.join(knownDir, 'bridge.config.json'), '{"name":"known-location"}\n', 'utf8');

  const result = await runWrapper(`--repo ${quote(originDir)} --branch main`, {
    cwd: root,
    env: wrapperEnv(bridgeHome, binDir, fakeBridge)
  });

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
  const installed = await fs.readFile(
    path.join(bridgeHome, 'schedule', 'repos', repoName, 'bridge.config.json'),
    'utf8'
  );
  assert.match(installed, /known-location/);
});

test('wrapper exits 3 when --config is missing', async (t) => {
  const cwd = await makeTempDir(t);
  const result = await runWrapper('--repo /tmp/unused --config /no/such/bridge.config.json', {
    cwd,
    env: { BRIDGE_HOME: cwd }
  });
  assert.equal(result.code, 3);
  assert.match(`${result.stdout}\n${result.stderr}`, /--config is not a readable file/);
});

test('cron example PATH includes a node bindir placeholder', async () => {
  const text = await fs.readFile(crontabExamplePath, 'utf8');
  assert.match(text, /^PATH=REPLACE_NODE_BIN_DIR:/m);
  assert.match(text, /--config REPLACE_PATH_TO_BRIDGE_CONFIG/);
});

test('launchd example forwards --config', async () => {
  const text = await fs.readFile(launchdExamplePath, 'utf8');
  assert.match(text, /--config/);
  assert.match(text, /REPLACE_PATH_TO_BRIDGE_CONFIG/);
});
