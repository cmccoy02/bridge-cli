#!/usr/bin/env node

/**
 * Run Bridge patch (dry-run) against a single corpus fixture.
 *
 * Usage:
 *   node corpus/scripts/run-fixture.mjs <fixture-name>
 *   node corpus/scripts/run-fixture.mjs clean-outdated
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.dirname(__dirname);
const REPO_ROOT = path.dirname(CORPUS_ROOT);
const FIXTURES_DIR = path.join(CORPUS_ROOT, 'fixtures');
const ARTIFACTS_DIR = path.join(CORPUS_ROOT, 'artifacts');

async function findBridgeCli() {
  const binPath = path.join(REPO_ROOT, 'bin', 'bridge.js');
  try {
    await fs.access(binPath);
    return binPath;
  } catch {
    throw new Error(`Bridge CLI not found at ${binPath}`);
  }
}

async function fixtureExists(name) {
  const fixturePath = path.join(FIXTURES_DIR, name);
  try {
    const stat = await fs.stat(fixturePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function runBridgePatch(bridgeCli, fixturePath, verbose = false) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const args = ['patch', '--dry-run', '--keep-workspace'];
    if (verbose) args.push('--verbose');

    const child = spawn('node', [bridgeCli, ...args], {
      cwd: fixturePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (verbose) process.stdout.write(data);
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (verbose) process.stderr.write(data);
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      resolve({ code, stdout, stderr, durationMs });
    });

    child.on('error', (err) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\nProcess error: ${err.message}`,
        durationMs: Date.now() - startTime
      });
    });
  });
}

function parseRunResult(fixtureName, result) {
  const { code, stdout, stderr, durationMs } = result;

  const status =
    code === 0
      ? stdout.includes('All dependencies are already up to date') ||
        stdout.includes('No dependencies to update')
        ? 'up_to_date'
        : 'patched'
      : 'failed';

  const hasBaselineNoise = stdout.includes('baseline script failure');
  const hasNewFailures =
    code !== 0 && stdout.includes('After-update validation failed');

  const updatedDepsMatch = stdout.match(
    /Deltas: (\d+) direct, (\d+) transitive/
  );
  const directUpdates = updatedDepsMatch ? parseInt(updatedDepsMatch[1], 10) : 0;
  const transitiveUpdates = updatedDepsMatch
    ? parseInt(updatedDepsMatch[2], 10)
    : 0;

  return {
    fixture: fixtureName,
    status,
    exitCode: code,
    durationMs,
    directUpdates,
    transitiveUpdates,
    hasBaselineNoise,
    hasNewFailures,
    timestamp: new Date().toISOString()
  };
}

export async function runFixture(fixtureName, options = {}) {
  const { verbose = false, saveArtifacts = true } = options;

  if (!(await fixtureExists(fixtureName))) {
    throw new Error(`Fixture not found: ${fixtureName}`);
  }

  const bridgeCli = await findBridgeCli();
  const fixturePath = path.join(FIXTURES_DIR, fixtureName);

  console.log(`\n[corpus] Running fixture: ${fixtureName}`);
  console.log(`[corpus] Fixture path: ${fixturePath}`);
  console.log(`[corpus] Bridge CLI: ${bridgeCli}`);

  const result = await runBridgePatch(bridgeCli, fixturePath, verbose);
  const parsed = parseRunResult(fixtureName, result);

  console.log(`[corpus] Status: ${parsed.status}`);
  console.log(`[corpus] Exit code: ${parsed.exitCode}`);
  console.log(`[corpus] Duration: ${parsed.durationMs}ms`);

  if (saveArtifacts) {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    const artifactPath = path.join(
      ARTIFACTS_DIR,
      `${fixtureName}-result.json`
    );
    await fs.writeFile(
      artifactPath,
      JSON.stringify(
        {
          ...parsed,
          stdout: result.stdout,
          stderr: result.stderr
        },
        null,
        2
      )
    );
    console.log(`[corpus] Artifact saved: ${artifactPath}`);
  }

  return parsed;
}

async function main() {
  const fixtureName = process.argv[2];

  if (!fixtureName) {
    console.error('Usage: node run-fixture.mjs <fixture-name>');
    console.error('');
    console.error('Available fixtures:');
    const fixtures = await fs.readdir(FIXTURES_DIR);
    for (const f of fixtures) {
      const stat = await fs.stat(path.join(FIXTURES_DIR, f));
      if (stat.isDirectory()) {
        console.error(`  - ${f}`);
      }
    }
    process.exit(1);
  }

  const verbose = process.argv.includes('--verbose');

  try {
    const result = await runFixture(fixtureName, { verbose });
    process.exit(result.exitCode === 0 || result.hasBaselineNoise ? 0 : 1);
  } catch (err) {
    console.error(`[corpus] Error: ${err.message}`);
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('run-fixture.mjs') ||
   process.argv[1].endsWith('run-fixture'));

if (isDirectRun) {
  main();
}
