import fs from 'node:fs/promises';
import path from 'node:path';

import { getBridgeHome } from './bridgeHome.js';
import { withDirLock } from './fileLock.js';
import { formatBytes } from './perfSampler.js';
import { classifyPrAction } from './runSignal.js';
import { formatDurationMs } from './scriptSummary.js';

export const DAILY_SUMMARY_SCHEMA_VERSION = 'bridge-daily-summary.v1';

export function utcDateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function getDailySummaryDir(bridgeHome = getBridgeHome()) {
  return path.join(bridgeHome, 'schedule', 'summaries', 'daily');
}

export function getDailySummaryPath(dateStamp = utcDateStamp(), bridgeHome = getBridgeHome()) {
  return path.join(getDailySummaryDir(bridgeHome), `${dateStamp}.md`);
}

export function getLatestSummaryPath(bridgeHome = getBridgeHome()) {
  return path.join(bridgeHome, 'schedule', 'LATEST.md');
}

function failureKindSuffix(kind) {
  if (kind === 'new' || kind === 'baseline' || kind === 'unmeasured') {
    return ` (${kind})`;
  }

  return '';
}

export function formatAfterScriptLine(scriptSummary) {
  const rows = scriptSummary?.scripts || [];

  if (rows.length === 0) {
    if (scriptSummary?.earlyExit) {
      return `none (${scriptSummary.earlyExit})`;
    }

    return scriptSummary?.afterScriptsRan === false ? 'none ran' : 'none configured';
  }

  return rows
    .map(
      (row) =>
        `${row.name} ${row.result} ${formatDurationMs(row.durationMs)}${failureKindSuffix(row.failureKind)}`
    )
    .join(', ');
}

export function oneLineFailureReason(report = {}) {
  const failure = report.outcome?.failure;
  const early = report.outcome?.earlyExit;
  const newFailures = (report.outcome?.scriptSummary?.scripts || []).filter(
    (row) => row.result === 'fail' && row.failureKind === 'new'
  );

  if (failure?.message) {
    return String(failure.message).split('\n')[0].trim();
  }

  if (newFailures.length > 0) {
    return `after-script ${newFailures[0].name} new failure`;
  }

  if (early?.code) {
    return String(early.code).replace(/_/g, ' ');
  }

  if (early && typeof early === 'string') {
    return early.replace(/_/g, ' ');
  }

  if (report.run?.status && report.run.status !== 'pushed' && report.run.status !== 'dry_run') {
    return String(report.run.status).replace(/_/g, ' ');
  }

  return '';
}

export function prLinkLabel(pullRequest) {
  const action = classifyPrAction(pullRequest);
  const url = pullRequest?.url || '';

  if (!url && (action === 'none' || !action)) {
    return '—';
  }

  if (action === 'created') {
    return url ? `new ${url}` : 'new';
  }

  if (action === 'reused') {
    return url ? `reused ${url}` : 'reused';
  }

  if (action === 'updated' || action === 'existing') {
    return url ? `updated ${url}` : 'updated';
  }

  return url || action || '—';
}

function packageLine(dependencySummary) {
  const direct = Number(dependencySummary?.directChanged) || 0;
  const transitive = Number(dependencySummary?.transitiveChanged) || 0;
  const total = Number(dependencySummary?.totalChanged) || direct + transitive;

  if (total === 0) {
    return 'none';
  }

  return `${direct} direct, ${transitive} transitive`;
}

export function repoEntryFromReport(report, extras = {}) {
  const status = report.run?.status || extras.status || 'unknown';
  const failed = ['failed', 'failed_preflight', 'cancelled'].includes(status);
  const reason = failed || extras.failureReason ? oneLineFailureReason(report) || extras.failureReason || '' : '';

  return {
    repo: report.target?.repository || extras.repo || 'unknown',
    runId: report.run?.id || extras.runId || '',
    status,
    durationMs: Number(report.run?.durationMs) || Number(extras.durationMs) || 0,
    packages: packageLine(report.outcome?.dependencySummary),
    packagesUpdated: Number(report.outcome?.dependencySummary?.totalChanged) || 0,
    afterScripts: formatAfterScriptLine(report.outcome?.scriptSummary),
    scriptSummary: report.outcome?.scriptSummary || null,
    pr: prLinkLabel(report.outcome?.pullRequest),
    prAction: classifyPrAction(report.outcome?.pullRequest),
    prUrl: report.outcome?.pullRequest?.url || '',
    failureReason: reason,
    performance: report.performance || extras.performance || null
  };
}

export function buildDailySummaryModel({
  dateStamp = utcDateStamp(),
  repos = [],
  batch = null
} = {}) {
  const uniqueRepos = [...new Set(repos.map((entry) => entry.repo).filter(Boolean))];
  const failed = repos.filter((entry) => entry.failureReason || /fail|cancel/i.test(entry.status));
  const packagesUpdated = repos.reduce((sum, entry) => sum + (Number(entry.packagesUpdated) || 0), 0);

  return {
    schemaVersion: DAILY_SUMMARY_SCHEMA_VERSION,
    dateStamp,
    generatedAt: new Date().toISOString(),
    batch,
    repos,
    totals: {
      repos: uniqueRepos.length,
      packagesUpdated,
      failed: failed.length,
      wallMs: Number(batch?.performance?.wallMs) || repos.reduce((sum, entry) => sum + (entry.durationMs || 0), 0)
    }
  };
}

export function formatDailySummary(model) {
  const batch = model.batch || null;
  const perf = batch?.performance;
  const lines = [
    `Bridge daily summary  ${model.dateStamp}`,
    batch?.id ? `Batch: ${batch.id}` : '',
    perf
      ? `Wall: ${formatDurationMs(perf.wallMs)}  (sum of runs ${formatDurationMs(perf.runWallMs)})`
      : `Wall: ${formatDurationMs(model.totals.wallMs)}`,
    perf
      ? `Peak RSS: ${formatBytes(perf.peakRssBytes)}  CPU: ${formatDurationMs(perf.cpuUserMs)} user / ${formatDurationMs(perf.cpuSystemMs)} sys`
      : '',
    '',
    `Repos: ${
      model.repos.length > 0 ? model.repos.map((entry) => entry.repo).join(', ') : 'none'
    }`,
    `Packages updated: ${model.totals.packagesUpdated}`,
    ''
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');

  if (model.repos.length === 0) {
    lines.push('No Bridge runs recorded for this day.', '');
    return `${lines.join('\n').trim()}\n`;
  }

  for (const entry of model.repos) {
    lines.push(
      `${entry.repo}  ${entry.status}  ${formatDurationMs(entry.durationMs)}`,
      `  Packages: ${entry.packages}`,
      `  After-scripts: ${entry.afterScripts}`,
      `  PR: ${entry.pr}`
    );

    if (entry.failureReason) {
      lines.push(`  Failure: ${entry.failureReason}`);
    }

    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

async function readJsonReport(reportPath) {
  try {
    return JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch {
    return null;
  }
}

function reportStartedAt(report) {
  return String(report.run?.startedAt || report.generatedAt || '');
}

function reportFinishedAt(report) {
  return String(report.run?.finishedAt || report.generatedAt || report.run?.startedAt || '');
}

async function listRunReports(bridgeHome = getBridgeHome()) {
  const runsDir = path.join(bridgeHome, 'runs');
  let entries = [];

  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const reports = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const reportPath = path.join(runsDir, entry.name, 'bridge-report.v1.json');
    const report = await readJsonReport(reportPath);

    if (!report?.run) {
      continue;
    }

    reports.push({ report, reportPath });
  }

  reports.sort((left, right) =>
    reportStartedAt(left.report).localeCompare(reportStartedAt(right.report))
  );

  return reports;
}

// LATEST.md covers one batch, not the whole day. With an explicit batch, take
// every report stamped with its id (or whose run id the batch captured, for
// reports written without one). Otherwise follow the most recently finished
// run: its batch if it had one, or that run alone.
function selectLatestBatchReports(listed, { batchId = '', batchRunIds = [] } = {}) {
  if (batchId) {
    const runIds = new Set(batchRunIds.filter(Boolean));
    return {
      batchId,
      reports: listed.filter(
        ({ report }) => report.run.batchId === batchId || runIds.has(report.run.id)
      )
    };
  }

  if (listed.length === 0) {
    return { batchId: '', reports: [] };
  }

  const latest = listed.reduce((newest, entry) =>
    reportFinishedAt(entry.report).localeCompare(reportFinishedAt(newest.report)) >= 0
      ? entry
      : newest
  );
  const latestBatchId = latest.report.run.batchId || '';

  if (!latestBatchId) {
    return { batchId: '', reports: [latest] };
  }

  return {
    batchId: latestBatchId,
    reports: listed.filter(({ report }) => report.run.batchId === latestBatchId)
  };
}

function withExtraRepos(fromReports, extraRepos) {
  const seen = new Set(fromReports.map((entry) => entry.runId).filter(Boolean));
  const extras = extraRepos.filter((entry) => !entry.runId || !seen.has(entry.runId));
  return [...fromReports, ...extras];
}

export async function rebuildDailySummary({
  dateStamp = utcDateStamp(),
  bridgeHome = getBridgeHome(),
  batch = null,
  batchRunIds = [],
  extraRepos = []
} = {}) {
  const allReports = await listRunReports(bridgeHome);
  const todaysReports = allReports.filter(({ report }) =>
    reportStartedAt(report).startsWith(dateStamp)
  );
  const selected = batch?.id
    ? selectLatestBatchReports(allReports, { batchId: batch.id, batchRunIds })
    : selectLatestBatchReports(todaysReports);

  // The dated file is the archive of every run that day; LATEST.md is the latest batch.
  const dailyModel = buildDailySummaryModel({
    dateStamp,
    repos: withExtraRepos(
      todaysReports.map(({ report }) => repoEntryFromReport(report)),
      extraRepos
    )
  });
  const model = buildDailySummaryModel({
    dateStamp,
    repos: withExtraRepos(
      selected.reports.map(({ report }) => repoEntryFromReport(report)),
      extraRepos
    ),
    batch: batch || (selected.batchId ? { id: selected.batchId } : null)
  });
  const dailyText = formatDailySummary(dailyModel);
  const text = formatDailySummary(model);
  const summaryPath = getDailySummaryPath(dateStamp, bridgeHome);
  const latestPath = getLatestSummaryPath(bridgeHome);
  const lockDir = path.join(getDailySummaryDir(bridgeHome), '.write.lock');

  await withDirLock(lockDir, async () => {
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
    await fs.mkdir(path.dirname(latestPath), { recursive: true });
    await fs.writeFile(summaryPath, dailyText, 'utf8');
    await fs.writeFile(latestPath, text, 'utf8');
    if (batch) {
      await fs.writeFile(
        path.join(getDailySummaryDir(bridgeHome), `${dateStamp}.batch.json`),
        `${JSON.stringify({ ...model, text }, null, 2)}\n`,
        'utf8'
      );
    }
  });

  return { model, text, summaryPath, latestPath, dailyModel, dailyText };
}
