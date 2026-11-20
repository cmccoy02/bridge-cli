#!/usr/bin/env node
// Scores the collected run records: writes the daily (and weekly) markdown report and
// refreshes scoreboard.json on the data repo. Runs in pg-report with FLEET_TOKEN as
// GH_TOKEN.
//
// Usage: node score.mjs [--date YYYY-MM-DD] [--weekly]

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadFleetConfig } from './lib/fleet.mjs';
import { renderDaily, renderWeekly, summarize } from './lib/scorecard.mjs';
import { gh, git, log } from './lib/exec.mjs';

export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = d.getTime();
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = 1 + Math.round((firstThursday - yearStart.getTime()) / (7 * 24 * 3600 * 1000) - (((yearStart.getUTCDay() + 6) % 7) - 3) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function readRecords(text) {
  return text
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function withinDays(record, days) {
  const at = Date.parse(record.collectedAt);
  if (!Number.isFinite(at)) return false;
  return Date.now() - at <= days * 24 * 3600 * 1000;
}

async function main() {
  const argv = process.argv.slice(2);
  let date = new Date().toISOString().slice(0, 10);
  let weekly = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--date') (date = argv[i + 1]), (i += 1);
    else if (argv[i] === '--weekly') weekly = true;
  }

  const config = await loadFleetConfig();
  const org = config.fleetOrg;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-score-'));
  await gh(['repo', 'clone', `${org}/${config.dataRepo}`, dataDir, '--', '--depth', '1']);

  const allRecords = readRecords(await fs.readFile(path.join(dataDir, 'records', 'runs.jsonl'), 'utf8').catch(() => ''));
  const dayRecords = allRecords.filter(
    (record) => record.experimentId === `daily-${date}` || String(record.collectedAt || '').slice(0, 10) === date
  );

  const dailyMd = renderDaily(dayRecords, { date });
  await fs.mkdir(path.join(dataDir, 'reports', 'daily'), { recursive: true });
  await fs.writeFile(path.join(dataDir, 'reports', 'daily', `${date}.md`), dailyMd);

  const scoreboard = summarize(allRecords, { generatedAt: new Date().toISOString() });
  await fs.writeFile(path.join(dataDir, 'scoreboard.json'), `${JSON.stringify(scoreboard, null, 2)}\n`);

  if (weekly) {
    const week = isoWeek(new Date(`${date}T00:00:00Z`));
    const weekRecords = allRecords.filter((record) => withinDays(record, 7));
    await fs.mkdir(path.join(dataDir, 'reports', 'weekly'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'reports', 'weekly', `${week}.md`), renderWeekly(weekRecords, { week }));
    log(`wrote weekly report ${week}`);
  }

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Bridge Proving Ground',
    GIT_AUTHOR_EMAIL: 'proving-ground@buildwithbridge.ai',
    GIT_COMMITTER_NAME: 'Bridge Proving Ground',
    GIT_COMMITTER_EMAIL: 'proving-ground@buildwithbridge.ai'
  };
  await git(['add', '-A'], { cwd: dataDir });
  const status = await git(['status', '--porcelain'], { cwd: dataDir });
  if (status.stdout.trim()) {
    await git(['commit', '-q', '-m', `score ${date}`], { cwd: dataDir, env });
    await git(['push', '-q', 'origin', 'HEAD:main'], { cwd: dataDir });
    log(`scored ${dayRecords.length} run(s) for ${date} (match ${((scoreboard.matchRate || 0) * 100).toFixed(1)}%)`);
  } else {
    log('no scorecard changes');
  }

  await fs.rm(dataDir, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`score failed: ${error.message}\n`);
    process.exit(1);
  });
}
