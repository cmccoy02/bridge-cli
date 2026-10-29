import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getBridgeVersion,
  readBridgeGitSha,
  readPackageVersion,
  writeBuildInfo
} from '../src/core/bridgeVersion.js';

const cliPath = fileURLToPath(new URL('../bin/bridge.js', import.meta.url));

test('getBridgeVersion includes the package version and git commit', () => {
  const version = getBridgeVersion();
  assert.match(version, new RegExp(`^${readPackageVersion()} \\([0-9a-f]+\\)$`));
});

test('bridge --version prints the commit', () => {
  const result = spawnSync(process.execPath, [cliPath, '--version'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), new RegExp(`^${readPackageVersion()} \\([0-9a-f]+\\)$`));
});

async function makeHostRepoWithInstalledBridge(t) {
  const hostDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-version-host-'));
  t.after(async () => {
    await fs.rm(hostDir, { recursive: true, force: true });
  });

  const gitArgs = ['-c', 'user.name=Host', '-c', 'user.email=host@example.test'];
  execFileSync('git', ['init', '-q'], { cwd: hostDir });
  execFileSync('git', [...gitArgs, 'commit', '-q', '--allow-empty', '-m', 'host'], { cwd: hostDir });
  const hostSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: hostDir })
    .toString()
    .trim();
  const installedDir = path.join(hostDir, 'node_modules', 'bridge-cli');
  await fs.mkdir(installedDir, { recursive: true });

  return { hostDir, hostSha, installedDir };
}

test('an installed copy inside another repo never reports that repo\'s commit', async (t) => {
  const { hostSha, installedDir } = await makeHostRepoWithInstalledBridge(t);

  assert.equal(readBridgeGitSha({ cwd: installedDir }), '');
  const version = getBridgeVersion({
    cwd: installedDir,
    buildInfoPath: path.join(installedDir, 'build-info.json')
  });
  assert.equal(version, readPackageVersion());
  assert.doesNotMatch(version, new RegExp(hostSha));
});

test('an installed copy reports the commit recorded in build-info.json at pack time', async (t) => {
  const { hostSha, installedDir } = await makeHostRepoWithInstalledBridge(t);
  const buildInfoPath = path.join(installedDir, 'build-info.json');
  const packedSha = readBridgeGitSha();
  assert.match(packedSha, /^[0-9a-f]{7,}$/);

  const written = writeBuildInfo({ buildInfoPath });
  assert.equal(written.gitSha, packedSha);
  assert.deepEqual(JSON.parse(await fs.readFile(buildInfoPath, 'utf8')), { gitSha: packedSha });

  const version = getBridgeVersion({ cwd: installedDir, buildInfoPath });
  assert.equal(version, `${readPackageVersion()} (${packedSha})`);
  assert.notEqual(packedSha, hostSha);
});

test('malformed build-info.json is ignored', async (t) => {
  const { installedDir } = await makeHostRepoWithInstalledBridge(t);
  const buildInfoPath = path.join(installedDir, 'build-info.json');
  await fs.writeFile(buildInfoPath, '{"gitSha":"not a sha; rm -rf"}\n', 'utf8');

  assert.equal(getBridgeVersion({ cwd: installedDir, buildInfoPath }), readPackageVersion());
});
