import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareAuditSnapshots,
  parseNpmAuditJson
} from '../src/core/audit.js';
import {
  compareBundleAnalyses,
  parseVisualizerHtml
} from '../src/core/bundleAnalysis.js';
import { ConfigError, loadConfig } from '../src/core/configReader.js';
import { selectPatchScopes } from '../src/commands/patch.js';
import { resolvePathInside, resolveRealPathInside } from '../src/core/pathSafety.js';
import { redactSensitiveText } from '../src/core/redaction.js';
import {
  addNpmInstallLinksFlag,
  parseLocalPackageArguments,
  prepareNpmLocalPackages,
  restoreNpmLocalPackages
} from '../src/core/localPackages.js';
import { runCommand } from '../src/core/executor.js';
import { computeDepDeltas } from '../src/core/lockfileDiff.js';

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-security-'));

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  return tempDir;
}

test('scope paths cannot escape the isolated workspace lexically', async (t) => {
  const root = await makeTempDir(t);

  assert.equal(resolvePathInside(root, 'deploy/service'), path.join(root, 'deploy/service'));
  assert.throws(() => resolvePathInside(root, '../outside'), /must remain inside/);
  assert.throws(() => resolvePathInside(root, '/tmp/outside'), /absolute paths/);
});

test('scope symlinks cannot escape the isolated workspace', async (t) => {
  const root = await makeTempDir(t);
  const outside = await makeTempDir(t);
  const linkPath = path.join(root, 'linked-scope');

  await fs.symlink(outside, linkPath);

  await assert.rejects(
    () => resolveRealPathInside(root, 'linked-scope'),
    /symlink resolves outside/
  );
});

test('config validation rejects traversal and duplicate scopes', async (t) => {
  const root = await makeTempDir(t);
  const config = {
    packageManager: 'npm',
    installCommand: 'npm install',
    updateCommand: 'npm update',
    cleanCommands: [],
    scopes: [
      {
        path: '../outside',
        installCommand: 'npm install',
        updateCommand: 'npm update',
        cleanCommands: []
      },
      {
        path: 'deploy/service',
        installCommand: 'npm install',
        updateCommand: 'npm update',
        cleanCommands: []
      },
      {
        path: 'deploy/service',
        installCommand: 'npm install',
        updateCommand: 'npm update',
        cleanCommands: []
      }
    ]
  };

  await fs.writeFile(
    path.join(root, 'bridge.config.json'),
    `${JSON.stringify(config)}\n`,
    'utf8'
  );

  await assert.rejects(
    () => loadConfig(root),
    (error) =>
      error instanceof ConfigError &&
      error.message.includes('relative path inside the repository') &&
      error.message.includes('duplicates another scope')
  );
});

test('npm audit snapshots are parsed and security regressions are detected', () => {
  const before = {
    parsed: true,
    counts: parseNpmAuditJson(
      JSON.stringify({
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 1,
            moderate: 2,
            high: 1,
            critical: 0,
            total: 4
          }
        }
      })
    ).counts
  };
  const after = {
    parsed: true,
    counts: parseNpmAuditJson(
      JSON.stringify({
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 1,
            moderate: 2,
            high: 2,
            critical: 0,
            total: 5
          }
        }
      })
    ).counts
  };
  const comparison = compareAuditSnapshots(before, after);

  assert.equal(comparison.comparable, true);
  assert.equal(comparison.regressed, true);
  assert.equal(comparison.delta.high, 1);
  assert.equal(comparison.delta.total, 1);
});

test('activity text redacts common credential forms', () => {
  const input = [
    'https://user:password@example.com/repo.git',
    'token=abc123',
    'Authorization: Bearer secret-token',
    '//registry.example.com/:_authToken=npm-secret'
  ].join(' ');
  const redacted = redactSensitiveText(input);

  assert.doesNotMatch(redacted, /password|abc123|secret-token|npm-secret/);
  assert.match(redacted, /\[redacted\]/);
});

test('rollup visualizer reports produce enforceable before/after bundle deltas', () => {
  const makeReport = (renderedLength, brotliLength) => `
    <html><script>
    const data = {"version":2,"nodeParts":{"a":{"renderedLength":${renderedLength},"gzipLength":0,"brotliLength":${brotliLength}},"b":{"renderedLength":100,"gzipLength":0,"brotliLength":40}},"options":{"brotli":true}};
    const run = () => {};
    </script></html>
  `;
  const before = parseVisualizerHtml(makeReport(900, 360));
  const after = parseVisualizerHtml(makeReport(1050, 440));
  const comparison = compareBundleAnalyses(before, after, {
    metric: 'brotli',
    maxIncreasePercent: 10
  });

  assert.equal(before.totals.rendered, 1000);
  assert.equal(before.totals.brotli, 400);
  assert.equal(after.totals.brotli, 480);
  assert.equal(comparison.deltaBytes, 80);
  assert.equal(comparison.deltaPercent, 20);
  assert.equal(comparison.thresholdExceeded, true);
});

test('an omitted byte threshold does not block a bundle within the percent budget', () => {
  const before = {
    totals: {
      brotli: 1000
    }
  };
  const after = {
    totals: {
      brotli: 1040
    }
  };
  const comparison = compareBundleAnalyses(before, after, {
    metric: 'brotli',
    maxIncreasePercent: 5,
    maxIncreaseBytes: null
  });

  assert.equal(comparison.deltaPercent, 4);
  assert.equal(comparison.percentExceeded, false);
  assert.equal(comparison.bytesExceeded, false);
  assert.equal(comparison.thresholdExceeded, false);
});

test('a declared nested scope can be selected without running the root scope', () => {
  const config = {
    packageManager: 'npm',
    installCommand: 'npm install',
    updateCommand: 'npm update',
    cleanCommands: [],
    scopes: [
      {
        path: 'deploy/description_bot',
        packageManager: 'pip',
        installCommand: 'pip install -r requirements.txt',
        updateCommand: 'pip freeze',
        cleanCommands: []
      }
    ]
  };
  const selected = selectPatchScopes(config, './deploy/description_bot/');

  assert.equal(selected.length, 1);
  assert.equal(selected[0].path, 'deploy/description_bot');
  assert.throws(
    () => selectPatchScopes(config, 'deploy/missing'),
    /Unknown scope/
  );
});

test('local npm packages are removed from manifest and lockfile before staging', async (t) => {
  const root = await makeTempDir(t);
  const project = path.join(root, 'project');
  const published = path.join(root, 'published');
  const linked = path.join(root, 'linked');

  await Promise.all([
    fs.mkdir(project),
    fs.mkdir(published),
    fs.mkdir(linked)
  ]);
  await fs.writeFile(
    path.join(published, 'package.json'),
    `${JSON.stringify({ name: 'local-fixture', version: '1.0.0' })}\n`
  );
  await fs.writeFile(
    path.join(linked, 'package.json'),
    `${JSON.stringify({ name: 'local-fixture', version: '1.1.0' })}\n`
  );
  await fs.writeFile(
    path.join(project, 'package.json'),
    `${JSON.stringify({
      name: 'consumer',
      version: '1.0.0',
      dependencies: {
        'local-fixture': 'file:../published'
      }
    }, null, 2)}\n`
  );
  await runCommand('npm install --package-lock-only --ignore-scripts', {
    cwd: project,
    quiet: true
  });

  const snapshot = await prepareNpmLocalPackages({
    cwd: project,
    localPackages: [{ name: 'local-fixture', path: linked }]
  });
  const preparedManifest = await fs.readFile(path.join(project, 'package.json'), 'utf8');

  assert.match(preparedManifest, new RegExp(linked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await restoreNpmLocalPackages(snapshot, { cwd: project });

  const finalManifest = await fs.readFile(path.join(project, 'package.json'), 'utf8');
  const finalLock = await fs.readFile(path.join(project, 'package-lock.json'), 'utf8');

  assert.match(finalManifest, /file:\.\.\/published/);
  assert.doesNotMatch(finalManifest, new RegExp(linked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(finalLock, new RegExp(linked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('local package arguments are unique and Git metadata is rejected', async (t) => {
  const root = await makeTempDir(t);
  const localPackage = path.join(root, 'local');
  const project = path.join(root, 'project');

  await fs.mkdir(localPackage);
  await fs.mkdir(project);
  await fs.mkdir(path.join(localPackage, '.git'));
  await fs.writeFile(
    path.join(localPackage, 'package.json'),
    `${JSON.stringify({ name: 'unsafe-fixture', version: '1.0.0' })}\n`
  );
  await fs.writeFile(
    path.join(project, 'package.json'),
    `${JSON.stringify({
      name: 'consumer',
      dependencies: {
        'unsafe-fixture': 'file:../local'
      }
    })}\n`
  );
  await runCommand('npm install --package-lock-only --ignore-scripts', {
    cwd: project,
    quiet: true
  });

  assert.throws(
    () =>
      parseLocalPackageArguments(
        ['unsafe-fixture=./local', 'unsafe-fixture=./other'],
        root
      ),
    /Duplicate/
  );
  assert.equal(addNpmInstallLinksFlag('npm ci'), 'npm ci --install-links');
  assert.equal(
    addNpmInstallLinksFlag('npm update --save'),
    'npm update --save --install-links'
  );
  await assert.rejects(
    () =>
      prepareNpmLocalPackages({
        cwd: project,
        localPackages: [{ name: 'unsafe-fixture', path: localPackage }]
      }),
    /contains Git metadata/
  );
});

test('npm metrics retain duplicate transitive package paths', () => {
  const makeLock = (directVersion, nestedVersion) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {
          dependencies: {
            duplicate: '^1.0.0'
          }
        },
        'node_modules/duplicate': {
          version: directVersion
        },
        'node_modules/parent/node_modules/duplicate': {
          version: nestedVersion
        }
      }
    });
  const { deltas, summary } = computeDepDeltas({
    beforeContent: makeLock('1.0.0', '1.0.1'),
    afterContent: makeLock('1.1.0', '1.0.2'),
    lockfileFormat: 'json-npm',
    directDeps: new Set(['duplicate'])
  });

  assert.equal(deltas.length, 2);
  assert.equal(summary.directChanged, 1);
  assert.equal(summary.transitiveChanged, 1);
  assert.deepEqual(
    deltas.map((delta) => delta.dependencyPath).sort(),
    [
      'node_modules/duplicate',
      'node_modules/parent/node_modules/duplicate'
    ]
  );
});
