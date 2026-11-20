#!/usr/bin/env node
// Collects finished Bridge runs across the fleet into run records on the data repo.
// For each completed Bridge workflow run it downloads the artifacts, reads the final
// report, scans for honeytoken leaks, reads the PR and its CI conclusion, merges green
// PRs on steady fixtures, builds a run record and appends it to records/runs.jsonl.
// Raw artifacts are copied under raw/ for the weekly release. Idempotent: a run id
// already recorded is skipped. Runs in pg-collect with FLEET_TOKEN as GH_TOKEN.
//
// Usage: node collect.mjs [--fixtures a,b,c] [--limit 20]

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expectedForFixture, loadFixtures, loadFleetConfig, loadScenarios } from './lib/fleet.mjs';
import { buildRunRecord } from './lib/runRecord.mjs';
import { buildLeakAlert, postSlack } from './lib/notify.mjs';
import { gh, ghJson, git, log } from './lib/exec.mjs';

async function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else out.push(abs);
    }
  }
  return out;
}

async function readFirstJson(candidates) {
  for (const file of candidates) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      // try next
    }
  }
  return null;
}

/** Counts honeytoken sightings across every downloaded artifact file + the PR body. */
async function countHoneytokenLeaks(artifactDir, token, prBody) {
  if (!token) return 0;
  let count = 0;
  for (const file of await walkFiles(artifactDir)) {
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    count += text.split(token).length - 1;
  }
  count += String(prBody || '').split(token).length - 1;
  return count;
}

function ciConclusionFrom(rollup) {
  const checks = Array.isArray(rollup) ? rollup : [];
  const relevant = checks.filter((check) => check.__typename === 'CheckRun' || check.state || check.conclusion);
  if (relevant.length === 0) return null;
  const states = relevant.map((check) => String(check.conclusion || check.state || '').toUpperCase());
  if (states.some((state) => ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state))) {
    return 'failure';
  }
  if (states.every((state) => ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED'].includes(state))) {
    return 'success';
  }
  return null; // pending
}

async function findPullRequest(repo, branchName) {
  if (!branchName) return null;
  const prs = await ghJson(
    ['pr', 'list', '--repo', repo, '--head', branchName, '--state', 'all', '--json', 'number,url,state,mergedAt,body,statusCheckRollup', '--limit', '1'],
    { allowFailure: true }
  ).catch(() => []);
  const pr = (prs || [])[0];
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.url,
    state: String(pr.state || '').toLowerCase(),
    mergedAt: pr.mergedAt || null,
    body: pr.body || '',
    ciConclusion: ciConclusionFrom(pr.statusCheckRollup)
  };
}

function workflowTiming(run) {
  const created = Date.parse(run.createdAt);
  const updated = Date.parse(run.updatedAt);
  const timing = { totalMs: Number.isFinite(created && updated) ? updated - created : undefined };
  const jobs = Array.isArray(run.jobs) ? run.jobs : [];
  const jobDuration = (name) => {
    const job = jobs.find((candidate) => String(candidate.name || '').toLowerCase().includes(name));
    if (!job?.startedAt || !job?.completedAt) return undefined;
    return Date.parse(job.completedAt) - Date.parse(job.startedAt);
  };
  const updateJob = jobs.find((candidate) => String(candidate.name || '').toLowerCase().includes('update'));
  if (updateJob?.startedAt && Number.isFinite(created)) {
    timing.queuedMs = Date.parse(updateJob.startedAt) - created;
  }
  timing.updateJobMs = jobDuration('update');
  timing.publishJobMs = jobDuration('publish');
  return Object.fromEntries(Object.entries(timing).filter(([, value]) => Number.isFinite(value)));
}

async function collectFixture({ fixture, expected, org, limit, collectedAt, recorded, dataDir }) {
  const repo = `${org}/${fixture.id}`;
  const runs = await ghJson(
    ['run', 'list', '--repo', repo, '--workflow', 'bridge.yml', '--limit', String(limit), '--json', 'databaseId,headSha,conclusion,status,createdAt,updatedAt,url,event'],
    { allowFailure: true }
  ).catch(() => []);

  const records = [];
  for (const run of runs || []) {
    if (run.status !== 'completed') continue;

    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), `pg-run-${run.databaseId}-`));
    try {
      await gh(['run', 'download', String(run.databaseId), '--repo', repo, '--dir', artifactDir], { allowFailure: true });
      const report = await readFirstJson([
        path.join(artifactDir, 'bridge-report-final', 'bridge-report.final.json'),
        path.join(artifactDir, 'bridge-report.final.json'),
        path.join(artifactDir, 'bridge-handoff', 'bridge-report.v1.json')
      ]);

      const runId = report?.run?.id || `wf-${run.databaseId}`;
      if (recorded.has(runId)) continue;

      const experimentId = report?.experiment?.id || `collected-${collectedAt.slice(0, 10)}`;
      const detailed = await ghJson(
        ['run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs,createdAt,updatedAt'],
        { allowFailure: true }
      ).catch(() => ({}));

      const pr = await findPullRequest(repo, report?.git?.branchName);
      const token = `pg-honeytoken-${run.databaseId}`;
      const honeytokenLeaks = await countHoneytokenLeaks(artifactDir, token, pr?.body);

      // Merge green PRs on steady fixtures.
      if (fixture.mode === 'steady' && pr && pr.state === 'open' && pr.ciConclusion === 'success') {
        const merged = await gh(['pr', 'merge', String(pr.number), '--repo', repo, '--squash', '--delete-branch'], { allowFailure: true });
        if (merged.success) {
          pr.state = 'merged';
          pr.mergedAt = collectedAt;
          log(`    merged ${repo}#${pr.number}`);
        }
      }

      // Raw artifacts stay in Actions (30 days) and the weekly release; the record
      // only references where they will live in that release asset.
      const rawBundle = `raw/${experimentId}/${fixture.id}/${runId}`;

      const logsText = (await walkFiles(artifactDir))
        .filter((file) => /\.(log|txt|jsonl)$/.test(file))
        .slice(0, 20);
      let logsConcat = '';
      for (const file of logsText) {
        logsConcat += `${await fs.readFile(file, 'utf8').catch(() => '')}\n`;
      }

      const record = buildRunRecord({
        fixture,
        expected,
        report,
        pr,
        workflow: {
          runId: run.databaseId,
          runUrl: run.url,
          conclusion: run.conclusion,
          artifacts: ['bridge-handoff', 'bridge-logs-update', 'bridge-report-final', 'bridge-logs-publish', 'bridge-canary'],
          timing: workflowTiming({ ...detailed, createdAt: run.createdAt, updatedAt: run.updatedAt })
        },
        experimentId,
        honeytokenLeaks,
        collectedAt,
        rawBundle,
        logsText: logsConcat.slice(0, 20000)
      });

      records.push(record);
      recorded.add(runId);
      const leakNote = honeytokenLeaks > 0 ? ` !! ${honeytokenLeaks} HONEYTOKEN LEAK(S)` : '';
      log(`    ${fixture.id} ${runId}: ${record.actual.status} (${record.match ? 'match' : 'MISMATCH'})${leakNote}`);
    } finally {
      await fs.rm(artifactDir, { recursive: true, force: true });
    }
  }
  return records;
}

async function main() {
  const argv = process.argv.slice(2);
  let fixturesArg = '';
  let limit = 20;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--fixtures') (fixturesArg = argv[i + 1]), (i += 1);
    else if (argv[i] === '--limit') (limit = Number(argv[i + 1]) || 20), (i += 1);
  }

  const config = await loadFleetConfig();
  const org = config.fleetOrg;
  const scenarios = await loadScenarios();
  const only = new Set(fixturesArg ? fixturesArg.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const fixtures = (await loadFixtures()).filter((fixture) => only.size === 0 || only.has(fixture.id));
  const collectedAt = new Date().toISOString();

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-collect-'));
  await gh(['repo', 'clone', `${org}/${config.dataRepo}`, dataDir, '--', '--depth', '1']);

  const runsFile = path.join(dataDir, 'records', 'runs.jsonl');
  const existing = await fs.readFile(runsFile, 'utf8').catch(() => '');
  const recorded = new Set(
    existing
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line).runId;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
  );

  const newRecords = [];
  for (const fixture of fixtures) {
    log(`collecting ${fixture.id}`);
    const expected = expectedForFixture(fixture, scenarios);
    const records = await collectFixture({ fixture, expected, org, limit, collectedAt, recorded, dataDir });
    newRecords.push(...records);
  }

  // Honeytoken leaks are the one thing worth interrupting for - report immediately.
  const leaks = newRecords.filter((record) => (record.honeytokenLeaks || 0) > 0);
  if (leaks.length > 0 && process.env.SLACK_WEBHOOK_URL) {
    await postSlack(process.env.SLACK_WEBHOOK_URL, buildLeakAlert(leaks).text);
    log(`!! posted honeytoken-leak alert for ${leaks.length} run(s)`);
  }

  if (newRecords.length === 0) {
    log('no new runs to record');
    await fs.rm(dataDir, { recursive: true, force: true });
    return;
  }

  const appended = newRecords.map((record) => JSON.stringify(record)).join('\n');
  await fs.writeFile(runsFile, existing ? `${existing.replace(/\n*$/, '')}\n${appended}\n` : `${appended}\n`);

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Bridge Proving Ground',
    GIT_AUTHOR_EMAIL: 'proving-ground@buildwithbridge.ai',
    GIT_COMMITTER_NAME: 'Bridge Proving Ground',
    GIT_COMMITTER_EMAIL: 'proving-ground@buildwithbridge.ai'
  };
  await git(['add', '-A'], { cwd: dataDir });
  await git(['commit', '-q', '-m', `collect ${newRecords.length} run(s) ${collectedAt}`], { cwd: dataDir, env });
  await git(['push', '-q', 'origin', 'HEAD:main'], { cwd: dataDir });
  log(`recorded ${newRecords.length} run(s)`);
  await fs.rm(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  process.stderr.write(`collect failed: ${error.message}\n`);
  process.exit(1);
});
