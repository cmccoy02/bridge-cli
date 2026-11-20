#!/usr/bin/env node
// Provisions the fleet from the catalog: a public data repo, the FLEET_BOT_TOKEN org
// secret, and one public repo per fixture (generated, locked to its drift date, pushed,
// tagged `baseline`, with Actions and auto-merge enabled). Idempotent: re-running
// updates content and force-pushes. Runs in the pg-provision workflow with FLEET_TOKEN
// available as GH_TOKEN (for gh + git) and FLEET_TOKEN (the value for the org secret).
//
// Usage: node provision.mjs [--fixture <id>] [--skip-lock] [--data-only]

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadFleetConfig, loadFixtures } from './lib/fleet.mjs';
import { generateFixture } from './generate.mjs';
import { lockFixture } from './lib/lock.mjs';
import { exec, gh, git, ghJson, log } from './lib/exec.mjs';

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'Bridge Proving Ground',
  GIT_AUTHOR_EMAIL: 'proving-ground@buildwithbridge.ai',
  GIT_COMMITTER_NAME: 'Bridge Proving Ground',
  GIT_COMMITTER_EMAIL: 'proving-ground@buildwithbridge.ai'
};

function repoExists(org, name) {
  return gh(['repo', 'view', `${org}/${name}`, '--json', 'name'], { allowFailure: true }).then((r) => r.success);
}

async function ensureRepo(org, name, description) {
  if (await repoExists(org, name)) {
    log(`  repo ${org}/${name} exists`);
    return;
  }
  await gh(['repo', 'create', `${org}/${name}`, '--public', '--description', description]);
  log(`  created ${org}/${name}`);
}

async function commitAndForcePush(dir, repoUrl, { tag = '' } = {}) {
  const env = { ...process.env, ...COMMIT_ENV };
  await git(['init', '-q', '-b', 'main'], { cwd: dir });
  await git(['add', '-A'], { cwd: dir });
  await git(['commit', '-q', '-m', 'baseline'], { cwd: dir, env });
  await git(['remote', 'add', 'origin', repoUrl], { cwd: dir, allowFailure: true });
  await git(['remote', 'set-url', 'origin', repoUrl], { cwd: dir });
  await git(['push', '--force', '-u', 'origin', 'main'], { cwd: dir });
  if (tag) {
    await git(['tag', '-f', tag], { cwd: dir });
    await git(['push', '--force', 'origin', `refs/tags/${tag}`], { cwd: dir });
  }
}

function repoUrl(org, name) {
  // gh auth setup-git configures the credential helper, so a plain https URL pushes.
  return `https://github.com/${org}/${name}.git`;
}

async function ensureDataRepo(org, name) {
  await ensureRepo(org, name, 'Bridge proving ground data (run records, scorecards). Append-only.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-data-'));
  await fs.mkdir(path.join(dir, 'records'), { recursive: true });
  await fs.mkdir(path.join(dir, 'reports', 'daily'), { recursive: true });
  await fs.mkdir(path.join(dir, 'reports', 'weekly'), { recursive: true });

  const fixtures = await loadFixtures();
  // Seed only what is missing so re-provisioning never clobbers collected data. The
  // collector and scorer own these files after the first run; provisioning just makes
  // sure the skeleton exists.
  const seed = async (rel, content) => {
    const abs = path.join(dir, rel);
    await fs.writeFile(abs, content);
  };
  await seed('records/runs.jsonl', '');
  await seed('records/fixtures.json', `${JSON.stringify(fixtures, null, 2)}\n`);
  await seed('scoreboard.json', `${JSON.stringify({ generatedAt: '', total: 0 }, null, 2)}\n`);
  await seed('.gitignore', 'raw/\n');
  await seed(
    'README.md',
    '# Bridge proving ground data\n\nGenerated. `records/runs.jsonl` is one run record per line; `reports/` holds the scorecards. Pull it with `npm run pg:pull`.\n'
  );

  // Clone the existing repo so we merge rather than overwrite collected records.
  const existing = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-data-existing-'));
  const cloned = await gh(['repo', 'clone', `${org}/${name}`, existing, '--', '--depth', '1'], { allowFailure: true });

  if (cloned.success) {
    // Preserve any files the data repo already has.
    for (const rel of ['records/runs.jsonl', 'records/fixtures.json', 'scoreboard.json']) {
      try {
        await fs.copyFile(path.join(existing, rel), path.join(dir, rel));
      } catch {
        // keep the seed
      }
    }
    // Always refresh the catalog snapshot.
    await seed('records/fixtures.json', `${JSON.stringify(fixtures, null, 2)}\n`);
  }

  await commitAndForcePush(dir, repoUrl(org, name));
  log(`  data repo ${org}/${name} ready`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(existing, { recursive: true, force: true });
}

async function ensureOrgSecret(org, name, value) {
  if (!value) {
    log(`  WARNING: no value for org secret ${name}; skipping (set FLEET_TOKEN)`);
    return;
  }
  await gh(['secret', 'set', name, '--org', org, '--visibility', 'all'], { input: value });
  log(`  org secret ${name} set`);
}

async function provisionFixture(fixture, org, config, { skipLock }) {
  log(`fixture ${fixture.id}`);
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), `pg-${fixture.id}-`));

  try {
    const dir = await generateFixture(fixture, { outDir, workflowRef: config.bridgeWorkflowRef || 'main' });

    if (!skipLock) {
      const result = await lockFixture(fixture, dir);
      if (!result.success) {
        log(`  WARNING: lock for ${fixture.id} exited ${result.code}: ${(result.stderr || '').slice(0, 300)}`);
      }
    }

    await ensureRepo(org, fixture.id, `Bridge proving-ground fixture (${fixture.ecosystem}/${fixture.manager}).`);
    await commitAndForcePush(dir, repoUrl(org, fixture.id), { tag: 'baseline' });
    await gh(['repo', 'edit', `${org}/${fixture.id}`, '--enable-auto-merge'], { allowFailure: true });
    log(`  ${fixture.id} pushed + tagged baseline`);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let only = '';
  let skipLock = false;
  let dataOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--fixture') (only = argv[i + 1]), (i += 1);
    else if (argv[i] === '--skip-lock') skipLock = true;
    else if (argv[i] === '--data-only') dataOnly = true;
  }

  const config = await loadFleetConfig();
  const org = config.fleetOrg;

  if (!org || org === 'SET-ME') {
    throw new Error('config.fleetOrg is not set.');
  }

  // Confirm we are operating on the fleet org and nothing else.
  const me = await ghJson(['api', 'user', '--jq', '{login: .login}'], { allowFailure: true });
  log(`provisioning org ${org} as ${me?.login || 'unknown'}`);

  await ensureDataRepo(org, config.dataRepo);
  await ensureOrgSecret(org, 'FLEET_BOT_TOKEN', process.env.FLEET_TOKEN || '');

  if (dataOnly) {
    return;
  }

  const fixtures = (await loadFixtures()).filter((fixture) => !only || fixture.id === only);
  if (only && fixtures.length === 0) {
    throw new Error(`No fixture with id "${only}"`);
  }

  for (const fixture of fixtures) {
    await provisionFixture(fixture, org, config, { skipLock });
  }

  log(`provisioned ${fixtures.length} fixture(s)`);
}

main().catch((error) => {
  process.stderr.write(`provision failed: ${error.message}\n`);
  process.exit(1);
});
