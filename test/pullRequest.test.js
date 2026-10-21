import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPullRequestBody,
  createPullRequest,
  decidePullRequestReuse,
  findReusableBridgePullRequest,
  getForeignPullRequestCommits,
  getGitHubRepository,
  getStablePullRequestIdentity,
  isBridgeAuthoredCommit,
  makePullRequestScopeKey,
  parseBridgePrMarker,
  updatePullRequest
} from '../src/core/pullRequest.js';

test('GitHub repository parsing supports HTTPS and SSH origin URLs', () => {
  assert.equal(
    getGitHubRepository('https://github.com/cmccoy02/travelpassbook.com.git'),
    'cmccoy02/travelpassbook.com'
  );
  assert.equal(
    getGitHubRepository('git@github.com:cmccoy02/travelpassbook.com.git'),
    'cmccoy02/travelpassbook.com'
  );
  assert.equal(getGitHubRepository('https://gitlab.com/example/project.git'), '');
});

test('pull request creation reuses an available authenticated GitHub CLI', async () => {
  const commands = [];
  const result = await createPullRequest({
    cwd: '/tmp/repo',
    branchName: 'bridge/patch-2026-08-26',
    baseBranch: 'main',
    repoUrl: 'https://github.com/example/project.git',
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
  assert.match(commands[1], /--repo 'example\/project'/);
  assert.match(commands[1], /--base 'main'/);
  assert.match(commands[1], /--head 'bridge\/patch-2026-08-26'/);
  assert.match(commands[1], /--draft/);
});

test('pull request creation returns an existing PR after a retry', async () => {
  const commands = [];
  const result = await createPullRequest({
    cwd: '/tmp/repo',
    branchName: 'bridge/patch-2026-08-26',
    baseBranch: 'main',
    repoUrl: 'git@github.com:example/project.git',
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      commands.push(command);

      if (command === 'gh auth status') {
        return { success: true, stdout: '', stderr: '' };
      }

      if (command.startsWith('gh pr create')) {
        return { success: false, stdout: '', stderr: 'a pull request already exists' };
      }

      return {
        success: true,
        stdout: 'https://github.com/example/project/pull/42\n',
        stderr: ''
      };
    }
  });

  assert.equal(result.status, 'existing');
  assert.equal(result.url, 'https://github.com/example/project/pull/42');
  assert.match(commands[2], /gh pr view/);
  assert.match(commands[2], /--repo 'example\/project'/);
  assert.match(commands[2], /--head 'bridge\/patch-2026-08-26'/);
});

test('pull request body distinguishes NEW failures from pre-existing baseline failures', async () => {
  const commands = [];

  await createPullRequest({
    cwd: '/tmp/repo',
    branchName: 'bridge/patch-2026-09-25',
    baseBranch: 'main',
    repoUrl: 'https://github.com/example/project.git',
    dependencySummary: { directChanged: 1, transitiveChanged: 0 },
    validationResults: [
      {
        label: 'root',
        scriptDiff: { diff: { hasNewFailures: false, hasBaselineNoise: true } },
        comparison: {
          hasNewFailures: false,
          hasBaselineNoise: true,
          newFailureCount: 0,
          baselineFailureCount: 1,
          resolvedCount: 0
        }
      }
    ],
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

  assert.match(
    commands[1],
    /pre-existing baseline failure\(s\) \(already present before the update; not blocking\)/
  );
  assert.doesNotMatch(commands[1], /persist \(not blocking\)/);
  assert.doesNotMatch(commands[1], /baseline failure\(s\) \(unchanged\)/);
});

test('pull request body includes report path, package table, and bundle delta', async () => {
  const commands = [];

  await createPullRequest({
    cwd: '/tmp/repo',
    branchName: 'bridge/patch-2026-09-30',
    baseBranch: 'main',
    repoUrl: 'https://github.com/example/project.git',
    dependencySummary: {
      directChanged: 1,
      transitiveChanged: 2,
      byBump: { patch: 2, minor: 1, major: 0, other: 0 }
    },
    dependencyDeltas: [
      { name: '@apollo/client', from: '4.2.12', to: '4.3.1', bump: 'minor', kind: 'direct' }
    ],
    bundleResults: [
      {
        label: 'root',
        comparison: {
          metric: 'brotli',
          beforeBytes: 1024,
          afterBytes: 2048,
          deltaBytes: 1024,
          deltaPercent: 100
        }
      }
    ],
    runReportPath: '/tmp/bridge-home/runs/patch-1/bridge-report.v1.json',
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      commands.push(command);
      if (command === 'gh auth status') {
        return { success: true, stdout: '', stderr: '' };
      }
      return { success: true, stdout: 'https://github.com/example/project/pull/42\n', stderr: '' };
    }
  });

  assert.match(commands[1], /@apollo\/client/);
  assert.match(commands[1], /4\.2\.12/);
  assert.match(commands[1], /Bundle size/);
  assert.match(commands[1], /brotli/);
  assert.match(commands[1], /bridge-report\.v1\.json/);
});

test('pull request creation is unavailable when gh is not installed', async () => {
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

test('findReusableBridgePullRequest reuses an identical open Bridge PR', async () => {
  const stagedDiff = 'diff --git a/package-lock.json b/package-lock.json\nindex 111..222 100644\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n';
  const result = await findReusableBridgePullRequest({
    cwd: '/tmp/repo',
    repoUrl: 'https://github.com/example/project.git',
    baseBranch: 'main',
    branchPrefix: 'bridge/patch',
    stagedDiff,
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      if (command.startsWith('gh pr list')) {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              number: 5,
              url: 'https://github.com/example/project/pull/5',
              title: 'bridge: update dependencies (non-breaking)',
              headRefName: 'bridge/patch-2026-09-30-1426',
              baseRefName: 'main'
            }
          ])
        };
      }
      if (command.startsWith('gh pr diff')) {
        return { success: true, stdout: stagedDiff, stderr: '' };
      }
      return { success: false, stdout: '', stderr: 'unexpected' };
    }
  });

  assert.equal(result.identical, true);
  assert.equal(result.reuseAction, 'reuse_identical');
  assert.equal(result.url, 'https://github.com/example/project/pull/5');
});

test('findReusableBridgePullRequest updates a legacy Bridge PR with no reuse marker', async () => {
  const localDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n';
  const remoteDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-older\n+newer\n';
  const result = await findReusableBridgePullRequest({
    cwd: '/tmp/repo',
    repoUrl: 'https://github.com/example/project.git',
    baseBranch: 'main',
    branchPrefix: 'bridge/patch',
    stagedDiff: localDiff,
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      if (command.startsWith('gh pr list')) {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              number: 5,
              url: 'https://github.com/example/project/pull/5',
              title: 'bridge: update dependencies (non-breaking)',
              headRefName: 'bridge/patch-2026-09-30-1426',
              baseRefName: 'main'
            }
          ])
        };
      }
      if (command.startsWith('gh pr diff')) {
        return { success: true, stdout: remoteDiff, stderr: '' };
      }
      return { success: false, stdout: '', stderr: 'unexpected' };
    }
  });

  assert.equal(result.identical, false);
  assert.equal(result.sameFiles, true);
  assert.equal(result.number, 5);
  assert.equal(result.reuseAction, 'update');
});

test('findReusableBridgePullRequest updates only when the scope marker matches', async () => {
  const localDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n';
  const remoteDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-older\n+newer\n';
  const scopeKey = makePullRequestScopeKey({
    configSha256: 'abc',
    requestedScope: 'all',
    updateCommands: ['npm update']
  });
  const result = await findReusableBridgePullRequest({
    cwd: '/tmp/repo',
    repoUrl: 'https://github.com/example/project.git',
    baseBranch: 'main',
    branchPrefix: 'bridge/patch',
    stagedDiff: localDiff,
    scopeKey,
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      if (command.startsWith('gh pr list')) {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              number: 5,
              url: 'https://github.com/example/project/pull/5',
              title: 'bridge: update dependencies (non-breaking)',
              headRefName: 'bridge/patch-2026-09-30-1426',
              baseRefName: 'main',
              body: buildPullRequestBody({
                branchName: 'bridge/patch-2026-09-30-1426',
                baseBranch: 'main',
                scopeMeta: { v: 1, scopeKey }
              })
            }
          ])
        };
      }
      if (command.startsWith('gh pr diff')) {
        return { success: true, stdout: remoteDiff, stderr: '' };
      }
      return { success: false, stdout: '', stderr: 'unexpected' };
    }
  });

  assert.equal(result.reuseAction, 'update');
  assert.equal(result.sameFiles, true);
});

test('a narrower run does not reuse a broader Bridge PR', () => {
  const decision = decidePullRequestReuse({
    identical: false,
    localScopeKey: makePullRequestScopeKey({
      updateCommands: ['npm update react react-dom']
    }),
    remoteMarker: {
      scopeKey: makePullRequestScopeKey({
        updateCommands: ['npm update']
      })
    }
  });

  assert.equal(decision.action, 'open_new');
  assert.match(decision.reason, /different update scope/);
});

test('reuse identity is update config/command — not the changed package list', () => {
  const shared = {
    configSha256: 'abc',
    requestedScope: 'all',
    updateCommands: ['npm update']
  };

  assert.equal(
    makePullRequestScopeKey({ ...shared, directPackages: ['lodash'] }),
    makePullRequestScopeKey({ ...shared, directPackages: ['react', 'lodash'] })
  );
  assert.equal(makePullRequestScopeKey(shared), 'abc|all|npm update');
  assert.equal(
    getStablePullRequestIdentity(makePullRequestScopeKey(shared)),
    getStablePullRequestIdentity('abc|all|npm update|lodash,react')
  );
});

test('a new registry date updates the open Bridge PR when identity matches', () => {
  const identity = makePullRequestScopeKey({
    configSha256: 'abc',
    updateCommands: ['npm update']
  });
  const decision = decidePullRequestReuse({
    identical: false,
    localScopeKey: identity,
    remoteMarker: { scopeKey: 'abc|all|npm update|lodash' }
  });

  assert.equal(decision.action, 'update');
});

test('legacy Bridge PRs without a reuse marker are updated', () => {
  const decision = decidePullRequestReuse({
    identical: false,
    localScopeKey: makePullRequestScopeKey({
      updateCommands: ['npm update']
    }),
    remoteMarker: null
  });

  assert.equal(decision.action, 'update');
});

test('reviewer commits are foreign even when the subject uses the Bridge prefix', () => {
  const commits = [
    {
      messageHeadline: 'bridge: update dependencies (non-breaking)',
      authors: [{ name: 'Bridge', email: 'bridge@example.test', login: 'bridge-cli' }]
    },
    {
      messageHeadline: 'bridge: update dependencies (non-breaking)',
      authors: [{ name: 'Reviewer', email: 'reviewer@example.test', login: 'reviewer' }]
    }
  ];

  assert.equal(isBridgeAuthoredCommit(commits[0]), true);
  assert.equal(isBridgeAuthoredCommit(commits[1]), false);
  assert.equal(getForeignPullRequestCommits(commits).length, 1);
  assert.equal(getForeignPullRequestCommits(commits)[0].authors[0].login, 'reviewer');

  const decision = decidePullRequestReuse({
    identical: false,
    localScopeKey: 'abc',
    remoteMarker: { scopeKey: 'abc' },
    foreignCommits: getForeignPullRequestCommits(commits)
  });

  assert.equal(decision.action, 'open_new');
  assert.match(decision.reason, /did not author/);
});

test('findReusableBridgePullRequest updates when the package set and files change', async () => {
  const localDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n' +
    'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+new\n';
  const remoteDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-older\n+newer\n';
  const localScopeKey = makePullRequestScopeKey({
    configSha256: 'abc',
    updateCommands: ['npm update']
  });
  const remoteScopeKey = 'abc|all|npm update|lodash';
  const result = await findReusableBridgePullRequest({
    cwd: '/tmp/repo',
    repoUrl: 'https://github.com/example/project.git',
    baseBranch: 'main',
    branchPrefix: 'bridge/patch',
    stagedDiff: localDiff,
    scopeKey: localScopeKey,
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      if (command.startsWith('gh pr list')) {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              number: 9,
              url: 'https://github.com/example/project/pull/9',
              title: 'bridge: update dependencies (non-breaking)',
              headRefName: 'bridge/patch-2026-10-01',
              baseRefName: 'main',
              body: buildPullRequestBody({
                branchName: 'bridge/patch-2026-10-01',
                baseBranch: 'main',
                scopeMeta: { v: 1, scopeKey: remoteScopeKey }
              }),
              author: { login: 'bridge-cli', name: 'Bridge' },
              commits: [
                {
                  messageHeadline: 'bridge: update dependencies (non-breaking)',
                  authors: [{ name: 'Bridge', email: 'bridge@example.test', login: 'bridge-cli' }]
                }
              ]
            }
          ])
        };
      }
      if (command.startsWith('gh pr diff')) {
        return { success: true, stdout: remoteDiff, stderr: '' };
      }
      return { success: false, stdout: '', stderr: 'unexpected' };
    }
  });

  assert.equal(result.identical, false);
  assert.equal(result.sameFiles, false);
  assert.equal(result.number, 9);
  assert.equal(result.reuseAction, 'update');
});

test('findReusableBridgePullRequest prefers the oldest matching open Bridge PR', async () => {
  const localDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n';
  const remoteDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-older\n+newer\n';
  const scopeKey = makePullRequestScopeKey({
    configSha256: 'abc',
    updateCommands: ['npm update']
  });
  const result = await findReusableBridgePullRequest({
    cwd: '/tmp/repo',
    repoUrl: 'https://github.com/example/project.git',
    baseBranch: 'main',
    branchPrefix: 'bridge/patch',
    stagedDiff: localDiff,
    scopeKey,
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      if (command.startsWith('gh pr list')) {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              number: 10,
              url: 'https://github.com/example/project/pull/10',
              title: 'bridge: update dependencies (non-breaking)',
              headRefName: 'bridge/patch-2026-10-02',
              baseRefName: 'main',
              body: buildPullRequestBody({
                branchName: 'bridge/patch-2026-10-02',
                baseBranch: 'main',
                scopeMeta: { v: 1, scopeKey }
              })
            },
            {
              number: 9,
              url: 'https://github.com/example/project/pull/9',
              title: 'bridge: update dependencies (non-breaking)',
              headRefName: 'bridge/patch-2026-10-01',
              baseRefName: 'main',
              body: buildPullRequestBody({
                branchName: 'bridge/patch-2026-10-01',
                baseBranch: 'main',
                scopeMeta: { v: 1, scopeKey: `${scopeKey}|lodash` }
              })
            }
          ])
        };
      }
      if (command.startsWith('gh pr diff')) {
        return { success: true, stdout: remoteDiff, stderr: '' };
      }
      return { success: false, stdout: '', stderr: 'unexpected' };
    }
  });

  assert.equal(result.number, 9);
  assert.equal(result.reuseAction, 'update');
});

test('findReusableBridgePullRequest refuses to update over reviewer-authored commits', async () => {
  const localDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n';
  const remoteDiff =
    'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-older\n+newer\n';
  const scopeKey = makePullRequestScopeKey({
    configSha256: 'abc',
    updateCommands: ['npm update']
  });
  const result = await findReusableBridgePullRequest({
    cwd: '/tmp/repo',
    repoUrl: 'https://github.com/example/project.git',
    baseBranch: 'main',
    branchPrefix: 'bridge/patch',
    stagedDiff: localDiff,
    scopeKey,
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      if (command.startsWith('gh pr list')) {
        return {
          success: true,
          stdout: JSON.stringify([
            {
              number: 9,
              url: 'https://github.com/example/project/pull/9',
              title: 'bridge: update dependencies (non-breaking)',
              headRefName: 'bridge/patch-2026-10-01',
              baseRefName: 'main',
              body: buildPullRequestBody({
                branchName: 'bridge/patch-2026-10-01',
                baseBranch: 'main',
                scopeMeta: { v: 1, scopeKey }
              }),
              author: { login: 'bridge-cli', name: 'Bridge' },
              commits: [
                {
                  messageHeadline: 'bridge: update dependencies (non-breaking)',
                  authors: [{ name: 'Bridge', email: 'bridge@example.test', login: 'bridge-cli' }]
                },
                {
                  messageHeadline: 'bridge: update dependencies (non-breaking)',
                  authors: [{ name: 'Reviewer', email: 'reviewer@example.test', login: 'reviewer' }]
                }
              ]
            }
          ])
        };
      }
      if (command.startsWith('gh pr diff')) {
        return { success: true, stdout: remoteDiff, stderr: '' };
      }
      return { success: false, stdout: '', stderr: 'unexpected' };
    }
  });

  assert.equal(result.reuseAction, 'open_new');
  assert.match(result.reuseReason, /did not author/);
});

test('updatePullRequest patches the PR body through gh api', async () => {
  const commands = [];
  const result = await updatePullRequest({
    cwd: '/tmp/repo',
    number: 5,
    repoUrl: 'https://github.com/example/project.git',
    body: buildPullRequestBody({
      branchName: 'bridge/patch-2026-09-30-1426',
      baseBranch: 'main',
      runReportPath: '/tmp/report.json'
    }),
    commandExistsFn: async () => true,
    runCommandFn: async (command) => {
      commands.push(command);
      return { success: true, stdout: '', stderr: '' };
    }
  });

  assert.equal(result.status, 'updated');
  assert.match(commands[0], /gh api/);
  assert.match(commands[0], /-X PATCH/);
  assert.match(commands[0], /repos\/example\/project\/pulls\/5/);
  assert.doesNotMatch(commands[0], /gh pr edit/);
});

test('updatePullRequest reports failure instead of success', async () => {
  const result = await updatePullRequest({
    cwd: '/tmp/repo',
    number: 5,
    repoUrl: 'https://github.com/example/project.git',
    body: 'updated body',
    commandExistsFn: async () => true,
    runCommandFn: async () => ({
      success: false,
      stdout: '',
      stderr: 'GraphQL: Projects (classic) is being deprecated'
    })
  });

  assert.equal(result.status, 'failed');
  assert.match(result.message, /could not update pull request #5/);
  assert.match(result.message, /Projects \(classic\)/);
});

test('PR body includes a hidden scope marker', () => {
  const body = buildPullRequestBody({
    branchName: 'bridge/patch-1',
    baseBranch: 'main',
    scopeMeta: { v: 1, scopeKey: 'abc' }
  });
  const marker = parseBridgePrMarker(body);
  assert.equal(marker.v, 1);
  assert.equal(marker.scopeKey, 'abc');
});
