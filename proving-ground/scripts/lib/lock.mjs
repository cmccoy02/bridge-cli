// Pins a generated fixture's dependencies to its drift date, so it "starts behind".
// Runs in the provision workflow where every toolchain is installed. Only npm and uv
// have a precise absolute cutoff (--before / --exclude-newer); pnpm and Yarn get the
// npm-style `before` best-effort, and poetry/pip-compile/pipenv/mix lock to the latest
// at provision time (documented limitation - they still drift as upstream moves on).

import { spawn } from 'node:child_process';
import path from 'node:path';

import { exec, log } from './exec.mjs';

const REGISTRY_PORT = 4873;

export async function startMockRegistry(fixtureDir, { port = REGISTRY_PORT } = {}) {
  const pgDir = path.join(fixtureDir, '.pg');
  const child = spawn(
    'node',
    [path.join(pgDir, 'mock-registry.mjs'), '--port', String(port), '--packages', path.join(pgDir, 'packages'), '--ages', path.join(pgDir, 'ages.json')],
    { stdio: 'ignore', detached: false }
  );

  // Wait for readiness.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://localhost:${port}/-/ping`);
      if (response.ok) {
        return { stop: () => child.kill('SIGTERM') };
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill('SIGTERM');
  throw new Error('mock registry did not become ready');
}

export async function lockToDriftDate(fixture, dir) {
  const before = fixture.driftDate;
  const beforeEnv = { ...process.env, npm_config_before: before };

  switch (fixture.manager) {
    case 'npm':
      return exec('npm', ['install', '--package-lock-only', `--before=${before}`, '--no-audit', '--no-fund', '--loglevel=warn', '--fetch-retries=2'], { cwd: dir });
    case 'pnpm':
      return exec('pnpm', ['install', '--lockfile-only'], { cwd: dir, env: beforeEnv });
    case 'yarn-berry':
      return exec('yarn', ['install', '--mode=update-lockfile'], { cwd: dir, env: beforeEnv });
    case 'uv':
      return exec('uv', ['lock', `--exclude-newer=${before}T00:00:00Z`], { cwd: dir });
    case 'poetry':
      return exec('poetry', ['lock', '--no-interaction'], { cwd: dir });
    case 'pip-compile':
      return exec('pip-compile', ['--quiet', '--output-file=requirements.txt', 'requirements.in'], { cwd: dir });
    case 'pipenv':
      return exec('pipenv', ['lock'], { cwd: dir, env: { ...process.env, PIPENV_IGNORE_VIRTUALENVS: '1' } });
    case 'mix':
      return exec('mix', ['deps.get'], { cwd: dir, env: { ...process.env, MIX_ENV: 'dev' } });
    default:
      throw new Error(`no locker for manager ${fixture.manager}`);
  }
}

/** Lock a fixture, starting the mock registry first when it serves @pg packages. */
export async function lockFixture(fixture, dir) {
  let registry = null;
  if (fixture.usesMockRegistry) {
    registry = await startMockRegistry(dir);
    log(`  started mock registry for ${fixture.id}`);
  }

  try {
    const result = await lockToDriftDate(fixture, dir);
    return result;
  } finally {
    registry?.stop();
  }
}
