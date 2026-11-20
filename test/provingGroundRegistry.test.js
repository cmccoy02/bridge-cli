import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  buildStore,
  createTarball,
  integrityFor,
  packageNameFromPath
} from '../proving-ground/registry/lib/packument.mjs';
import { createRegistryServer } from '../proving-ground/registry/mock-registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = path.join(HERE, '..', 'proving-ground', 'registry', 'packages');
const AGES_PATH = path.join(HERE, '..', 'proving-ground', 'registry', 'ages.json');
const CANARY_POSTINSTALL = path.join(PACKAGES_DIR, 'canary', '1.0.1', 'postinstall.js');

const NOW = Date.parse('2026-11-20T00:00:00.000Z');

async function loadAges() {
  return JSON.parse(await fs.readFile(AGES_PATH, 'utf8'));
}

test('createTarball produces a gzipped, package-prefixed tar', () => {
  const tgz = createTarball([{ name: 'package/package.json', data: '{"name":"x"}' }]);
  const tar = zlib.gunzipSync(tgz);
  // The ustar name field holds the path in the first 100 bytes of the header.
  assert.equal(tar.subarray(0, 20).toString('ascii').replace(/\0+$/, ''), 'package/package.json');
  assert.match(integrityFor(tgz), /^sha512-/);
});

test('buildStore backdates publish times from the ages map', async () => {
  const ages = await loadAges();
  const store = await buildStore({ packagesDir: PACKAGES_DIR, ages, now: NOW });

  const fresh = store.get('@pg/fresh');
  assert.ok(fresh, '@pg/fresh is in the store');
  assert.equal(fresh.packument['dist-tags'].latest, '2.0.1');

  // 2.0.1 is planted ~2 hours before now; the 2.0.0 baseline is years old so it
  // locks cleanly under any drift date.
  const freshAgeHours = (NOW - Date.parse(fresh.packument.time['2.0.1'])) / (60 * 60 * 1000);
  assert.ok(Math.abs(freshAgeHours - 2) < 0.01, `2.0.1 should be ~2h old, was ${freshAgeHours}`);
  const baseAgeDays = (NOW - Date.parse(fresh.packument.time['2.0.0'])) / (24 * 60 * 60 * 1000);
  assert.ok(baseAgeDays > 365, `2.0.0 baseline should be over a year old, was ${baseAgeDays}`);

  // Every planted scenario package is present.
  for (const name of ['@pg/semver-lie', '@pg/fresh', '@pg/canary', '@pg/peer-clash']) {
    assert.ok(store.get(name), `${name} is in the store`);
  }
});

test('packageNameFromPath parses scoped packuments and tarball paths', () => {
  assert.deepEqual(packageNameFromPath('/@pg%2ffresh'), { name: '@pg/fresh', filename: '' });
  assert.deepEqual(packageNameFromPath('/@pg/fresh'), { name: '@pg/fresh', filename: '' });
  assert.deepEqual(packageNameFromPath('/@pg/fresh/-/fresh-2.0.0.tgz'), {
    name: '@pg/fresh',
    filename: 'fresh-2.0.0.tgz'
  });
});

test('the mock registry server serves packuments and valid tarballs', async () => {
  const ages = await loadAges();
  const { server } = await createRegistryServer({ packagesDir: PACKAGES_DIR, ages, now: NOW });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;

  try {
    const packument = await (await fetch(`${base}/@pg%2fsemver-lie`)).json();
    assert.equal(packument.name, '@pg/semver-lie');
    assert.ok(packument.versions['1.2.1'], 'serves the planted version');
    const tarballUrl = packument.versions['1.2.1'].dist.tarball;
    assert.ok(tarballUrl.startsWith(base), 'tarball URL points back at this host');

    const tarball = Buffer.from(await (await fetch(tarballUrl)).arrayBuffer());
    assert.equal(integrityFor(tarball), packument.versions['1.2.1'].dist.integrity);
    const tar = zlib.gunzipSync(tarball);
    assert.ok(tar.length > 0, 'tarball gunzips');

    const missing = await fetch(`${base}/@pg/does-not-exist`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test('the canary postinstall records only the token-like env it can actually see', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-canary-'));

  try {
    // Scrubbed environment (what Bridge gives untrusted installs): sees nothing.
    execFileSync('node', [CANARY_POSTINSTALL], {
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir }
    });
    let reports = await fs.readdir(path.join(dir, 'pg-canary'));
    let clean = JSON.parse(await fs.readFile(path.join(dir, 'pg-canary', reports[0]), 'utf8'));
    assert.equal(clean.seenCount, 0, 'a scrubbed install leaks nothing');

    await fs.rm(path.join(dir, 'pg-canary'), { recursive: true, force: true });

    // Leaky environment: the canary records exactly what reached it.
    execFileSync('node', [CANARY_POSTINSTALL], {
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: dir,
        GH_TOKEN: 'pg-honeytoken-test',
        BRIDGE_API_TOKEN: 'pg-honeytoken-test'
      }
    });
    reports = await fs.readdir(path.join(dir, 'pg-canary'));
    const leaked = JSON.parse(await fs.readFile(path.join(dir, 'pg-canary', reports[0]), 'utf8'));
    assert.equal(leaked.seenCount, 2);
    assert.equal(leaked.seen.GH_TOKEN, 'pg-honeytoken-test');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
