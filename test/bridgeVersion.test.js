import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getBridgeVersion, readPackageVersion } from '../src/core/bridgeVersion.js';

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
