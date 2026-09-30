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

test('doctor warns when auditCommand is empty', () => {
  const notices = collectDisabledGateNotices({
    packageManager: 'pnpm',
    auditCommand: '',
    beforeScripts: [],
    afterScripts: []
  });

  assert.ok(notices.some((notice) => /Security audit is inactive/.test(notice)));
  assert.equal(
    notices.some((notice) => /Lockfile metrics and the direct-major gate are inactive for pnpm/.test(notice)),
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
