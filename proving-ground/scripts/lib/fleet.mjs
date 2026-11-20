// Shared proving-ground helpers: load the catalog, map a catalog manager to a Bridge
// package manager and an ecosystem, and resolve a fixture's expected outcome from the
// scenarios it plants. Pure (no network, no GitHub); the scripts layer the IO on top.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROVING_GROUND_DIR = path.resolve(HERE, '..', '..');
export const REPO_ROOT = path.resolve(PROVING_GROUND_DIR, '..');

// catalog manager -> how to build and run it.
const MANAGER_PROFILES = {
  npm: { packageManager: 'npm', kind: 'node', corepack: false, npmEleven: true },
  pnpm: { packageManager: 'pnpm', kind: 'node', corepack: true },
  'yarn-berry': { packageManager: 'yarn', kind: 'node', corepack: true },
  'yarn-classic': { packageManager: 'yarn', kind: 'node', corepack: true },
  uv: { packageManager: 'uv', kind: 'python' },
  poetry: { packageManager: 'poetry', kind: 'python' },
  'pip-compile': { packageManager: 'pip-compile', kind: 'python' },
  pipenv: { packageManager: 'pipenv', kind: 'python' },
  pip: { packageManager: 'pip', kind: 'python' },
  mix: { packageManager: 'mix', kind: 'elixir' }
};

export function managerProfile(manager) {
  const profile = MANAGER_PROFILES[manager];

  if (!profile) {
    throw new Error(`Unknown catalog manager: ${manager}`);
  }

  return profile;
}

export async function loadFleetConfig(rootDir = PROVING_GROUND_DIR) {
  return JSON.parse(await fs.readFile(path.join(rootDir, 'config.json'), 'utf8'));
}

export async function loadScenarios(rootDir = PROVING_GROUND_DIR) {
  const raw = JSON.parse(await fs.readFile(path.join(rootDir, 'catalog', 'scenarios.json'), 'utf8'));
  const byId = new Map();

  for (const scenario of raw.scenarios || []) {
    byId.set(scenario.id, scenario);
  }

  return byId;
}

export async function loadFixtures(rootDir = PROVING_GROUND_DIR) {
  const dir = path.join(rootDir, 'catalog', 'fixtures');
  const entries = await fs.readdir(dir);
  const fixtures = [];

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    const fixture = JSON.parse(await fs.readFile(path.join(dir, entry), 'utf8'));

    if (fixture.id !== path.basename(entry, '.json')) {
      throw new Error(`Fixture id "${fixture.id}" does not match file name ${entry}`);
    }

    fixtures.push(fixture);
  }

  return fixtures;
}

export async function loadFixture(id, rootDir = PROVING_GROUND_DIR) {
  const fixtures = await loadFixtures(rootDir);
  const fixture = fixtures.find((candidate) => candidate.id === id);

  if (!fixture) {
    throw new Error(`No fixture with id "${id}"`);
  }

  return fixture;
}

export function fixtureUsesHoneytokens(fixture) {
  return (fixture.scenarios || []).includes('canary-postinstall');
}

/**
 * Merges the expected outcomes of every scenario a fixture plants into one record the
 * scorer compares against. `status` is the union of allowed statuses; `gate` is the
 * first non-null gate; `knownMiss` is true if any scenario is a known miss.
 */
export function expectedForFixture(fixture, scenarios) {
  const statuses = new Set();
  let gate = null;
  let knownMiss = false;
  let honeytokenLeaks = null;
  const mustNotContain = [];
  let failureCategory = null;

  for (const id of fixture.scenarios || []) {
    const scenario = scenarios.get(id);

    if (!scenario) {
      throw new Error(`Fixture ${fixture.id} references unknown scenario "${id}"`);
    }

    const expect = scenario.expect || {};
    for (const status of expect.status || []) {
      statuses.add(status);
    }
    if (gate === null && expect.gate) {
      gate = expect.gate;
    }
    if (expect.knownMiss) {
      knownMiss = true;
    }
    if (typeof expect.honeytokenLeaks === 'number') {
      honeytokenLeaks = expect.honeytokenLeaks;
    }
    if (expect.mustNotContain) {
      mustNotContain.push(expect.mustNotContain);
    }
    if (expect.failureCategory && failureCategory === null) {
      failureCategory = expect.failureCategory;
    }
  }

  return {
    status: [...statuses],
    gate,
    knownMiss,
    ...(honeytokenLeaks !== null ? { honeytokenLeaks } : {}),
    ...(mustNotContain.length > 0 ? { mustNotContain } : {}),
    ...(failureCategory ? { failureCategory } : {})
  };
}
