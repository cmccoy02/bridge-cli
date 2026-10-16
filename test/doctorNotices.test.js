import assert from 'node:assert/strict';
import test from 'node:test';

import { collectDisabledGateNotices } from '../src/commands/validate.js';

test('doctor warns when lockfile metrics cannot run', () => {
  const notices = collectDisabledGateNotices({
    packageManager: 'mix',
    auditCommand: 'mix hex.audit',
    beforeScripts: [],
    afterScripts: []
  });

  assert.ok(notices.some((notice) => /Lockfile metrics and the direct-major gate are inactive for mix/.test(notice)));
});

test('doctor does not claim audit is inactive when a default audit exists', () => {
  const notices = collectDisabledGateNotices({
    packageManager: 'pnpm',
    auditCommand: '',
    beforeScripts: ['pnpm test'],
    afterScripts: ['pnpm test']
  });

  assert.equal(
    notices.some((notice) => /Security audit is inactive/.test(notice)),
    false
  );
  assert.equal(
    notices.some((notice) => /Lockfile metrics and the direct-major gate are inactive for pnpm/.test(notice)),
    false
  );
});

test('doctor warns when audit has no default and other gates are off', () => {
  const notices = collectDisabledGateNotices({
    packageManager: 'mix',
    auditCommand: '',
    beforeScripts: [],
    afterScripts: [],
    blockOnNewVulnerabilities: false,
    allowMajorUpdates: true
  });

  assert.ok(notices.some((notice) => /Security audit is inactive/.test(notice)));
  assert.ok(notices.some((notice) => /blockOnNewVulnerabilities is false/.test(notice)));
  assert.ok(notices.some((notice) => /allowMajorUpdates is true/.test(notice)));
  assert.ok(notices.some((notice) => /No beforeScripts or afterScripts/.test(notice)));
});

test('doctor explains skipBeforeScripts and does not warn about after-only scripts', () => {
  const notices = collectDisabledGateNotices({
    packageManager: 'npm',
    auditCommand: 'npm audit --json',
    skipBeforeScripts: true,
    beforeScripts: ['npm run typecheck'],
    afterScripts: ['npm run typecheck', 'npm run lint:ci']
  });

  assert.ok(notices.some((notice) => /beforeScripts are skipped/.test(notice)));
  assert.equal(
    notices.some((notice) => /cannot be compared to a committed baseline/.test(notice)),
    false
  );
});

test('doctor warns about after-only scripts', () => {
  const notices = collectDisabledGateNotices({
    packageManager: 'npm',
    auditCommand: 'npm audit --json',
    beforeScripts: ['npm run typecheck'],
    afterScripts: ['npm run typecheck', 'npm run lint:ci']
  });

  assert.ok(notices.some((notice) => /npm run lint:ci/.test(notice)));
  assert.ok(notices.some((notice) => /cannot be compared to a committed baseline/.test(notice)));
});
