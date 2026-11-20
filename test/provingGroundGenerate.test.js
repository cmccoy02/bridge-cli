import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  expectedForFixture,
  loadFixtures,
  loadScenarios,
  managerProfile
} from '../proving-ground/scripts/lib/fleet.mjs';
import { generateFixture } from '../proving-ground/scripts/generate.mjs';

const REQUIRED = ['id', 'tier', 'ecosystem', 'manager', 'template', 'size', 'driftDate', 'mode', 'scenarios'];
const MANAGERS = new Set([
  'npm',
  'pnpm',
  'yarn-berry',
  'yarn-classic',
  'uv',
  'poetry',
  'pip-compile',
  'pipenv',
  'pip',
  'mix'
]);

test('the catalog has the first 12 fixtures, each well-formed', async () => {
  const fixtures = await loadFixtures();
  const scenarios = await loadScenarios();
  assert.equal(fixtures.length, 12);

  const ids = new Set();
  for (const fixture of fixtures) {
    for (const key of REQUIRED) {
      assert.ok(fixture[key] !== undefined, `${fixture.id} is missing ${key}`);
    }
    assert.ok(/^[a-z0-9][a-z0-9-]{2,60}$/.test(fixture.id), `${fixture.id} is a valid id`);
    assert.ok(!ids.has(fixture.id), `${fixture.id} is unique`);
    ids.add(fixture.id);
    assert.ok(MANAGERS.has(fixture.manager), `${fixture.manager} is a known manager`);
    assert.match(fixture.driftDate, /^\d{4}-\d{2}-\d{2}$/);
    // Resolving the expected outcome also validates every scenario id exists.
    expectedForFixture(fixture, scenarios);
    // Every manager maps to a profile.
    managerProfile(fixture.manager);
  }
});

test('every planted scenario is exercised by at least one fixture', async () => {
  const fixtures = await loadFixtures();
  const planted = new Set(
    fixtures.flatMap((fixture) => fixture.scenarios).filter((id) => id !== 'clean-drift')
  );
  // The first 12 plant these cases (see TASK table).
  for (const id of ['semver-lie-caught', 'semver-lie-uncaught', 'too-new-release', 'canary-postinstall']) {
    assert.ok(planted.has(id), `${id} is planted in the first 12`);
  }
});

test('expectedForFixture merges a fixture with multiple scenarios', async () => {
  const scenarios = await loadScenarios();
  const canary = (await loadFixtures()).find((fixture) => fixture.id === 'js-npm-canary');
  const expected = expectedForFixture(canary, scenarios);

  // canary-postinstall sets honeytokenLeaks: 0; semver-lie-uncaught is a known miss.
  assert.equal(expected.honeytokenLeaks, 0);
  assert.equal(expected.knownMiss, true);

  const workspaces = (await loadFixtures()).find((fixture) => fixture.id === 'js-npm-workspaces');
  const tooNew = expectedForFixture(workspaces, scenarios);
  assert.equal(tooNew.gate, 'cooldown_block');
  assert.deepEqual(tooNew.mustNotContain, ['@pg/fresh@2.0.1']);
});

test('generateFixture emits a complete fleet-repo tree', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-gen-'));

  try {
    const fixtures = await loadFixtures();
    const express = fixtures.find((fixture) => fixture.id === 'js-npm-express-api');
    const dir = await generateFixture(express, { outDir, workflowRef: 'main' });

    const config = JSON.parse(await fs.readFile(path.join(dir, 'bridge.config.json'), 'utf8'));
    assert.equal(config.name, 'js-npm-express-api', 'the fixture name is stamped into the config');

    const copy = JSON.parse(await fs.readFile(path.join(dir, '.bridge-fixture.json'), 'utf8'));
    assert.equal(copy.id, 'js-npm-express-api');

    const bridgeYaml = await fs.readFile(path.join(dir, '.github/workflows/bridge.yml'), 'utf8');
    assert.match(bridgeYaml, /workflow_dispatch:/);
    assert.ok(!/on:\s*\n\s*schedule/.test(bridgeYaml), 'fixture bridge.yml has no cron');
    assert.match(bridgeYaml, /fixture-id: js-npm-express-api/);
    assert.match(bridgeYaml, /bridge-github-token: \$\{\{ secrets\.FLEET_BOT_TOKEN \}\}/);

    const ciYaml = await fs.readFile(path.join(dir, '.github/workflows/ci.yml'), 'utf8');
    assert.match(ciYaml, /on:\s*\n\s*push:/);
    assert.match(ciYaml, /pull_request:/);

    // A non-mock fixture has no .pg directory.
    assert.equal(
      await fs
        .access(path.join(dir, '.pg'))
        .then(() => true)
        .catch(() => false),
      false
    );
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('a mock-registry fixture gets a self-contained .pg and honeytoken planting', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-gen-'));

  try {
    const canary = (await loadFixtures()).find((fixture) => fixture.id === 'js-npm-canary');
    const dir = await generateFixture(canary, { outDir, workflowRef: 'main' });

    for (const rel of ['.pg/mock-registry.mjs', '.pg/ages.json', '.pg/setup-registry.sh', '.pg/packages/canary/1.0.1/postinstall.js']) {
      assert.ok(
        await fs.access(path.join(dir, rel)).then(() => true).catch(() => false),
        `${rel} exists`
      );
    }

    const setup = await fs.readFile(path.join(dir, '.pg/setup-registry.sh'), 'utf8');
    assert.match(setup, /pg-honeytoken-/, 'the canary fixture plants honeytokens');

    const bridgeYaml = await fs.readFile(path.join(dir, '.github/workflows/bridge.yml'), 'utf8');
    assert.match(bridgeYaml, /setup-script: \.pg\/setup-registry\.sh/);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
