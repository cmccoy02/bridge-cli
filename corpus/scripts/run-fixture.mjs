#!/usr/bin/env node

/**
 * Run Bridge patch (dry-run) against a single corpus fixture.
 *
 * Usage:
 *   node corpus/scripts/run-fixture.mjs <fixture-name>
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
  await fs.access(binPath);
  return binPath;
}

async function fixtureExists(name) {
  try {
    const stat = await fs.stat(path.join(FIXTURES_DIR, name));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function loadExpected(fixturePath) {
  try {
    return JSON.parse(await fs.readFile(path.join(fixturePath, 'expected.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function readLatestReport(bridgeHome) {
  const runsDir = path.join(bridgeHome, 'runs');
  let entries = [];

  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const reports = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const reportPath = path.join(runsDir, entry.name, 'bridge-report.v1.json');

    try {
      const stat = await fs.stat(reportPath);
      reports.push({ reportPath, modifiedMs: stat.mtimeMs });
    } catch {
      // ignore incomplete run dirs
    }
  }

  reports.sort((left, right) => right.modifiedMs - left.modifiedMs);

  if (reports.length === 0) {
    return null;
  }

  return JSON.parse(await fs.readFile(reports[0].reportPath, 'utf8'));
}

function runBridgePatch(bridgeCli, fixturePath, { verbose = false, bridgeHome }) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const args = ['patch', '--dry-run'];
    if (verbose) args.push('--verbose');

    const child = spawn('node', [bridgeCli, ...args], {
      cwd: fixturePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        BRIDGE_HOME: bridgeHome
      }
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
      resolve({ code, stdout, stderr, durationMs: Date.now() - startTime });
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

function harnessStatus(code, stdout, report) {
  const reportStatus = report?.run?.status;
  if (reportStatus === 'up_to_date' || report?.outcome?.earlyExit?.code === 'no_updates') {
    return 'up_to_date';
  }
  if (
    stdout.includes('All dependencies are already up to date') ||
    stdout.includes('No dependencies to update')
  ) {
    return 'up_to_date';
  }
  if (code === 0) {
    return 'patched';
  }
  return 'failed';
}

function parseRunResult(fixtureName, result, report) {
  const { code, stdout, durationMs } = result;
  const validation = report?.outcome?.validation || [];
  const hasNewFailures =
    validation.some((entry) => entry.hasNewFailures) ||
    report?.outcome?.earlyExit?.code === 'validation_block' ||
    /NEW after-script failure|already-failing command|was not in beforeScripts/.test(stdout);
  const hasBaselineNoise = validation.some((entry) => entry.hasBaselineNoise);
  const directUpdates = report?.outcome?.dependencySummary?.directChanged ??
    Number((stdout.match(/Deltas: (\d+) direct/) || [])[1] || 0);
  const transitiveUpdates = report?.outcome?.dependencySummary?.transitiveChanged ??
    Number((stdout.match(/Deltas: (\d+) direct, (\d+) transitive/) || [])[2] || 0);
  const phases = (report?.phases || []).map((phase) => String(phase.phase || '').split(':')[0]);

  return {
    fixture: fixtureName,
    status: harnessStatus(code, stdout, report),
    reportStatus: report?.run?.status || null,
    exitCode: code,
    durationMs,
    directUpdates,
    transitiveUpdates,
    hasBaselineNoise,
    hasNewFailures,
    phases,
    earlyExit: report?.outcome?.earlyExit || null,
    blockedCount: report?.outcome?.blockedCount || 0,
    timestamp: new Date().toISOString()
  };
}

function assertExpected(parsed, expected) {
  if (!expected) {
    return ['missing expected.json'];
  }

  const mismatches = [];

  if (expected.status && parsed.status !== expected.status) {
    mismatches.push(`status: got ${parsed.status}, expected ${expected.status}`);
  }

  if (typeof expected.exitCode === 'number' && parsed.exitCode !== expected.exitCode) {
    mismatches.push(`exitCode: got ${parsed.exitCode}, expected ${expected.exitCode}`);
  }

  if (typeof expected.hasNewFailures === 'boolean' && parsed.hasNewFailures !== expected.hasNewFailures) {
    mismatches.push(
      `hasNewFailures: got ${parsed.hasNewFailures}, expected ${expected.hasNewFailures}`
    );
  }

  if (typeof expected.hasBaselineNoise === 'boolean' && parsed.hasBaselineNoise !== expected.hasBaselineNoise) {
    mismatches.push(
      `hasBaselineNoise: got ${parsed.hasBaselineNoise}, expected ${expected.hasBaselineNoise}`
    );
  }

  if (typeof expected.minDirectUpdates === 'number' && parsed.directUpdates < expected.minDirectUpdates) {
    mismatches.push(
      `directUpdates: got ${parsed.directUpdates}, expected >= ${expected.minDirectUpdates}`
    );
  }

  if (Array.isArray(expected.absentPhases)) {
    for (const phase of expected.absentPhases) {
      if (parsed.phases.includes(phase)) {
        mismatches.push(`phase ${phase} should be absent after early exit`);
      }
    }
  }

  return mismatches;
}

export async function runFixture(fixtureName, options = {}) {
  const { verbose = false, saveArtifacts = true } = options;

  if (!(await fixtureExists(fixtureName))) {
    throw new Error(`Fixture not found: ${fixtureName}`);
  }

  const bridgeCli = await findBridgeCli();
  const fixturePath = path.join(FIXTURES_DIR, fixtureName);
  const expected = await loadExpected(fixturePath);
  const bridgeHome = path.join(ARTIFACTS_DIR, fixtureName, 'bridge-home');
  await fs.mkdir(bridgeHome, { recursive: true });

  console.log(`\n[corpus] Running fixture: ${fixtureName}`);
  console.log(`[corpus] Fixture path: ${fixturePath}`);
  console.log(`[corpus] Bridge CLI: ${bridgeCli}`);

  const result = await runBridgePatch(bridgeCli, fixturePath, { verbose, bridgeHome });
  const report = await readLatestReport(bridgeHome);
  const parsed = parseRunResult(fixtureName, result, report);
  const mismatches = assertExpected(parsed, expected);
  parsed.expected = expected;
  parsed.mismatches = mismatches;
  parsed.matched = mismatches.length === 0;

  console.log(`[corpus] Status: ${parsed.status}`);
  console.log(`[corpus] Exit code: ${parsed.exitCode}`);
  console.log(`[corpus] Duration: ${parsed.durationMs}ms`);
  if (mismatches.length > 0) {
    console.log(`[corpus] Expected-outcome mismatches:`);
    for (const mismatch of mismatches) {
      console.log(`[corpus]   - ${mismatch}`);
    }
  } else {
    console.log(`[corpus] Expected outcome matched`);
  }

  if (saveArtifacts) {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
    const artifactPath = path.join(ARTIFACTS_DIR, `${fixtureName}-result.json`);
    await fs.writeFile(
      artifactPath,
      JSON.stringify(
        {
          ...parsed,
          stdout: result.stdout,
          stderr: result.stderr,
          report
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
    process.exit(1);
  }

  const verbose = process.argv.includes('--verbose');

  try {
    const result = await runFixture(fixtureName, { verbose });
    process.exit(result.matched ? 0 : 1);
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
