import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultAuditCommand, parseAuditJson } from '../src/core/audit.js';
import { computeDepDeltas, parseLockfile } from '../src/core/lockfileDiff.js';
import { PACKAGE_MANAGER_PRESETS } from '../src/constants.js';

const PNPM_BEFORE = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      ms:
        specifier: ^2.1.2
        version: 2.1.2
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:
  left-pad@1.3.0:
    resolution: {integrity: sha512-abc}
  ms@2.1.2:
    resolution: {integrity: sha512-def}
`;

const PNPM_AFTER = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      ms:
        specifier: ^2.1.2
        version: 2.1.3
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:
  left-pad@1.3.0:
    resolution: {integrity: sha512-abc}
  ms@2.1.3:
    resolution: {integrity: sha512-ghi}
`;

const YARN_BEFORE = `# yarn lockfile v1

left-pad@^1.3.0:
  version "1.3.0"

ms@^2.1.2:
  version "2.1.2"
`;

const YARN_AFTER = `# yarn lockfile v1

left-pad@^1.3.0:
  version "1.3.0"

ms@^2.1.2:
  version "2.1.3"
`;

test('pnpm and yarn presets expose lockfile formats and default audits', () => {
  assert.equal(PACKAGE_MANAGER_PRESETS.pnpm.lockfileFormat, 'yaml-pnpm');
  assert.equal(PACKAGE_MANAGER_PRESETS.yarn.lockfileFormat, 'yarn-lock');
  assert.equal(PACKAGE_MANAGER_PRESETS.pnpm.auditCommand, 'pnpm audit --json');
  assert.equal(PACKAGE_MANAGER_PRESETS.yarn.auditCommand, 'yarn audit --json');
  assert.equal(defaultAuditCommand('pnpm'), 'pnpm audit --json');
  assert.equal(defaultAuditCommand('yarn'), 'yarn audit --json');
});

test('parseLockfile reads pnpm v9 package keys', () => {
  const map = parseLockfile(PNPM_AFTER, 'yaml-pnpm');
  assert.equal(map.get('ms').version, '2.1.3');
  assert.equal(map.get('left-pad').name, 'left-pad');
});

test('parseLockfile reads yarn classic lockfiles', () => {
  const map = parseLockfile(YARN_AFTER, 'yarn-lock');
  const ms = [...map.values()].find((entry) => entry.name === 'ms');
  assert.equal(ms.version, '2.1.3');
});

test('pnpm lockfile deltas count direct majors and patches', () => {
  const { deltas, summary } = computeDepDeltas({
    beforeContent: PNPM_BEFORE,
    afterContent: PNPM_AFTER,
    lockfileFormat: 'yaml-pnpm',
    directDeps: new Set(['ms', 'left-pad'])
  });

  assert.equal(summary.directChanged, 1);
  assert.equal(summary.byBump.patch, 1);
  assert.equal(deltas[0].name, 'ms');
  assert.equal(deltas[0].from, '2.1.2');
  assert.equal(deltas[0].to, '2.1.3');
  assert.equal(deltas[0].kind, 'direct');
});

test('yarn lockfile deltas classify direct vs transitive', () => {
  const { summary, deltas } = computeDepDeltas({
    beforeContent: YARN_BEFORE,
    afterContent: YARN_AFTER,
    lockfileFormat: 'yarn-lock',
    directDeps: new Set(['ms'])
  });

  assert.equal(summary.directChanged, 1);
  assert.equal(summary.transitiveChanged, 0);
  assert.equal(deltas[0].kind, 'direct');
});

test('yarn audit NDJSON is parsed for severity counts', () => {
  const parsed = parseAuditJson(
    '{"type":"auditAdvisory","data":{}}\n{"type":"auditSummary","data":{"vulnerabilities":{"info":0,"low":1,"moderate":0,"high":2,"critical":0}}}'
  );
  assert.equal(parsed.counts.high, 2);
  assert.equal(parsed.counts.low, 1);
});
