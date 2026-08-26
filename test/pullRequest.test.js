import assert from 'node:assert/strict';
import test from 'node:test';

import { createPullRequest } from '../src/core/pullRequest.js';

test('pull request creation reuses an available authenticated GitHub CLI', async () => {
  const commands = [];
  const result = await createPullRequest({
    cwd: '/tmp/repo',
    branchName: 'bridge/patch-2026-08-26',
    baseBranch: 'main',
    dependencySummary: { directChanged: 2, transitiveChanged: 5 },
    options: { draft: true },
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      commands.push(command);

      if (command === 'gh auth status') {
        return { success: true, stdout: '', stderr: '' };
      }

      return {
        success: true,
        stdout: 'https://github.com/example/project/pull/42\n',
        stderr: ''
      };
    }
  });

  assert.equal(result.status, 'created');
  assert.equal(result.url, 'https://github.com/example/project/pull/42');
  assert.equal(commands[0], 'gh auth status');
  assert.match(commands[1], /gh pr create/);
  assert.match(commands[1], /--base 'main'/);
  assert.match(commands[1], /--head 'bridge\/patch-2026-08-26'/);
  assert.match(commands[1], /--draft/);
});

test('pull request creation does not require GitHub CLI to push a branch', async () => {
  const result = await createPullRequest({
    cwd: '/tmp/repo',
    branchName: 'bridge/patch',
    baseBranch: 'main',
    commandExistsFn: async () => false
  });

  assert.equal(result.status, 'unavailable');
  assert.equal(result.url, '');
  assert.match(result.message, /not installed/);
});
