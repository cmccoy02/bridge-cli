#!/usr/bin/env node

/**
 * Initialize git repositories for corpus fixtures.
 * Required before running Bridge patch since it needs git context.
 *
 * Usage:
 *   node corpus/scripts/setup-fixtures.mjs
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.dirname(__dirname);
const FIXTURES_DIR = path.join(CORPUS_ROOT, 'fixtures');
const REMOTES_DIR = path.join(FIXTURES_DIR, '.remotes');

function exec(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    console.error(`Command failed: ${cmd}`);
    console.error(err.stderr || err.message);
    throw err;
  }
}

async function listFixtures() {
  const entries = await fs.readdir(FIXTURES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);
}

async function fixtureHasGit(fixturePath) {
  try {
    await fs.access(path.join(fixturePath, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function setupFixture(name) {
  const fixturePath = path.join(FIXTURES_DIR, name);
  const barePath = path.join(REMOTES_DIR, `${name}.git`);

  console.log(`[setup] Setting up fixture: ${name}`);

  if (await fixtureHasGit(fixturePath)) {
    console.log(`[setup]   Already initialized, skipping`);
    return;
  }

  await fs.mkdir(barePath, { recursive: true });

  console.log(`[setup]   Creating bare repo: ${barePath}`);
  exec(`git init --bare -q "${barePath}"`, CORPUS_ROOT);

  console.log(`[setup]   Initializing fixture git repo`);
  exec('git init -q', fixturePath);
  exec('git config user.email "corpus@example.com"', fixturePath);
  exec('git config user.name "Corpus Fixture"', fixturePath);

  console.log(`[setup]   Adding remote origin`);
  exec(`git remote add origin "${barePath}"`, fixturePath);

  console.log(`[setup]   Creating initial commit`);
  exec('git add -A', fixturePath);
  exec('git commit -q -m "Initial fixture state"', fixturePath);

  const branchResult = exec('git branch --show-current', fixturePath).trim();
  console.log(`[setup]   Pushing to origin (branch: ${branchResult})`);
  exec(`git push -u origin ${branchResult}`, fixturePath);

  console.log(`[setup]   Done`);
}

async function main() {
  console.log('[setup] Setting up corpus fixtures for Bridge testing');
  console.log(`[setup] Fixtures directory: ${FIXTURES_DIR}`);

  const fixtures = await listFixtures();
  console.log(`[setup] Found ${fixtures.length} fixtures`);

  for (const fixture of fixtures) {
    await setupFixture(fixture);
  }

  console.log('[setup] All fixtures ready');
}

main().catch((err) => {
  console.error(`[setup] Fatal error: ${err.message}`);
  process.exit(1);
});
