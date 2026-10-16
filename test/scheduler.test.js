import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCommand } from '../src/core/executor.js';

const wrapperPath = new URL('../scripts/bridge-daily.sh', import.meta.url).pathname;

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

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function writeFakeBridge(binDir, { exitCode = 0, writeSummary = true } = {}) {
  const fake = path.join(binDir, 'bridge');
  const script = `#!/usr/bin/env bash
set -euo pipefail
echo "fake-bridge $*"
if [[ "${writeSummary ? 1 : 0}" -eq 1 ]]; then
  run_dir="\${BRIDGE_HOME}/runs/patch-fake"
  mkdir -p "$run_dir/scripts"
  cat > "$run_dir/bridge-summary.md" <<'EOF'
# Bridge after-script summary
| Script | Result | Failure | Duration | Log |
| npm test | pass | — | 1ms | /tmp/test.log |
EOF
  echo '{}' > "$run_dir/bridge-report.v1.json"
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
    env: {
      BRIDGE_HOME: bridgeHome,
      PATH: `${binDir}:${process.env.PATH}`,
      BRIDGE_BIN: fakeBridge
    }
  });

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Saved summary:/);
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
    env: {
      BRIDGE_HOME: bridgeHome,
      PATH: `${binDir}:${process.env.PATH}`,
      BRIDGE_BIN: fakeBridge
    }
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
    env: {
      BRIDGE_HOME: bridgeHome,
      PATH: `${binDir}:${process.env.PATH}`,
      BRIDGE_BIN: fakeBridge
    }
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
    env: {
      BRIDGE_HOME: bridgeHome,
      PATH: `${binDir}:${process.env.PATH}`,
      BRIDGE_BIN: fakeBridge
    }
  });

  assert.equal(result.success, true, `${result.stdout}\n${result.stderr}`);
});
