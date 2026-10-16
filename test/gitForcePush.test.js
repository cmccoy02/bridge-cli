import assert from 'node:assert/strict';
import test from 'node:test';

import {
  forceWithLeasePushCommand,
  formatForeignCommitRefusal,
  getForeignCommits,
  isBridgeCommitSubject,
  parseCommitLogLines
} from '../src/core/git.js';

test('Bridge commit subjects are recognized by prefix', () => {
  assert.equal(isBridgeCommitSubject('bridge: update dependencies (non-breaking)'), true);
  assert.equal(isBridgeCommitSubject('fix lint'), false);
});

test('foreign commits are anything Bridge did not author', () => {
  const commits = parseCommitLogLines(
    [
      'aaa111\tBridge\tbridge@example.test\tbridge: update dependencies (non-breaking)',
      'bbb222\tReviewer\treviewer@example.test\tAddress review comments'
    ].join('\n')
  );
  const foreign = getForeignCommits(commits);

  assert.equal(foreign.length, 1);
  assert.equal(foreign[0].sha, 'bbb222');
  assert.match(
    formatForeignCommitRefusal('bridge/patch-x', foreign),
    /Refusing to force-push to bridge\/patch-x/
  );
  assert.match(formatForeignCommitRefusal('bridge/patch-x', foreign), /Stopped without pushing/);
});

test('force-with-lease is pinned to the inspected remote SHA', () => {
  const command = forceWithLeasePushCommand(
    'bridge/patch-2026-09-30-1426',
    'abc123def'
  );

  assert.equal(
    command,
    'git push --force-with-lease=refs/heads/bridge/patch-2026-09-30-1426:abc123def origin HEAD:bridge/patch-2026-09-30-1426'
  );
});
