import fs from 'node:fs/promises';

import { getActivityLogPath } from '../core/activityLogger.js';
import { findSavedRunReport } from '../core/runReport.js';
import { info, line, section, warn } from '../ui/logger.js';
import { printSummary } from '../ui/summary.js';

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

function parseJsonLine(rawLine) {
  const trimmed = rawLine.trim();

  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function readActivityEntries(logPath) {
  try {
    const content = await fs.readFile(logPath, 'utf8');
    const entries = [];

    for (const rawLine of content.split(/\r?\n/)) {
      const parsed = parseJsonLine(rawLine);

      if (parsed) {
        entries.push(parsed);
      }
    }

    return entries;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function eventTimestamp(event) {
  const ms = Date.parse(event?.at || '');
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeRepoFilter(repo) {
  if (typeof repo !== 'string') {
    return '';
  }

  return repo.trim();
}

function buildEmptyReport() {
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      runs: 0,
      lastRunAt: null,
      changed: 0,
      directChanged: 0,
      transitiveChanged: 0
    },
    byBump: {
      patch: 0,
      minor: 0,
      major: 0,
      other: 0
    },
    security: {
      auditedScopes: 0,
      beforeTotal: 0,
      afterTotal: 0,
      fixed: 0,
      introduced: 0
    },
    bundles: {
      checkedScopes: 0,
      increased: 0,
      decreased: 0,
      unchanged: 0,
      thresholdExceeded: 0
    },
    packages: [],
    repos: []
  };
}

function buildReport(entries, { repoFilter = '', limit = 10 } = {}) {
  const report = buildEmptyReport();
  const scopedEntries = repoFilter
    ? entries.filter((entry) => entry.repo === repoFilter)
    : entries;
  const depDeltas = scopedEntries.filter((entry) => entry.event === 'dep_delta');
  const depSummaries = scopedEntries.filter((entry) => entry.event === 'dep_delta_summary');
  const auditEvents = scopedEntries.filter(
    (entry) =>
      entry.event === 'phase' &&
      typeof entry.phase === 'string' &&
      (entry.phase.startsWith('audit_before:') || entry.phase.startsWith('audit_after:')) &&
      entry.counts &&
      typeof entry.counts === 'object'
  );
  const bundleEvents = scopedEntries.filter(
    (entry) =>
      entry.event === 'phase' &&
      typeof entry.phase === 'string' &&
      entry.phase.startsWith('bundle_comparison:') &&
      typeof entry.deltaBytes === 'number'
  );
  const runIds = new Set();
  const repos = new Set();
  const packageRollup = new Map();
  const auditsByRunScope = new Map();

  for (const auditEvent of auditEvents) {
    const scope = auditEvent.scope || auditEvent.phase.split(':').slice(1).join(':');
    const key = `${auditEvent.runId || 'unknown'}::${scope}`;
    const pair = auditsByRunScope.get(key) || {};

    if (auditEvent.phase.startsWith('audit_before:')) {
      pair.before = auditEvent.counts;
    } else {
      pair.after = auditEvent.counts;
    }

    auditsByRunScope.set(key, pair);
  }

  for (const pair of auditsByRunScope.values()) {
    if (!pair.before || !pair.after) {
      continue;
    }

    const beforeTotal = Number(pair.before.total) || 0;
    const afterTotal = Number(pair.after.total) || 0;
    report.security.auditedScopes += 1;
    report.security.beforeTotal += beforeTotal;
    report.security.afterTotal += afterTotal;

    if (afterTotal < beforeTotal) {
      report.security.fixed += beforeTotal - afterTotal;
    } else if (afterTotal > beforeTotal) {
      report.security.introduced += afterTotal - beforeTotal;
    }
  }

  for (const bundleEvent of bundleEvents) {
    report.bundles.checkedScopes += 1;

    if (bundleEvent.deltaBytes > 0) {
      report.bundles.increased += 1;
    } else if (bundleEvent.deltaBytes < 0) {
      report.bundles.decreased += 1;
    } else {
      report.bundles.unchanged += 1;
    }

    if (bundleEvent.thresholdExceeded) {
      report.bundles.thresholdExceeded += 1;
    }
  }

  for (const summary of depSummaries) {
    if (summary.runId) {
      runIds.add(summary.runId);
    }

    if (summary.repo) {
      repos.add(summary.repo);
    }
  }

  for (const delta of depDeltas) {
    if (delta.runId) {
      runIds.add(delta.runId);
    }

    if (delta.repo) {
      repos.add(delta.repo);
    }

    report.totals.changed += 1;

    if (delta.kind === 'direct') {
      report.totals.directChanged += 1;
    } else {
      report.totals.transitiveChanged += 1;
    }

    if (Object.prototype.hasOwnProperty.call(report.byBump, delta.bump)) {
      report.byBump[delta.bump] += 1;
    }

    const packageName = typeof delta.name === 'string' ? delta.name : '';
    const manager = typeof delta.manager === 'string' ? delta.manager : '';
    const key = `${manager}::${packageName.toLowerCase()}`;
    const seenAtMs = eventTimestamp(delta);
    const existing = packageRollup.get(key) || {
      name: packageName,
      manager,
      updates: 0,
      kind: delta.kind || 'transitive',
      lastFrom: null,
      lastTo: null,
      lastBump: null,
      lastSeenAt: null,
      lastSeenAtMs: 0
    };

    existing.updates += 1;

    if (seenAtMs >= existing.lastSeenAtMs) {
      existing.kind = delta.kind || existing.kind;
      existing.lastFrom = delta.from ?? null;
      existing.lastTo = delta.to ?? null;
      existing.lastBump = delta.bump ?? null;
      existing.lastSeenAt = delta.at || null;
      existing.lastSeenAtMs = seenAtMs;
    }

    packageRollup.set(key, existing);
  }

  report.totals.runs = runIds.size;

  const allRunEvents = [...depSummaries, ...depDeltas];
  allRunEvents.sort((a, b) => eventTimestamp(b) - eventTimestamp(a));
  report.totals.lastRunAt = allRunEvents.length > 0 ? allRunEvents[0].at || null : null;

  const packages = [...packageRollup.values()]
    .sort((left, right) => {
      if (right.updates !== left.updates) {
        return right.updates - left.updates;
      }

      return right.lastSeenAtMs - left.lastSeenAtMs;
    })
    .slice(0, limit)
    .map((entry) => ({
      name: entry.name,
      manager: entry.manager,
      updates: entry.updates,
      kind: entry.kind,
      lastFrom: entry.lastFrom,
      lastTo: entry.lastTo,
      lastBump: entry.lastBump,
      lastSeenAt: entry.lastSeenAt
    }));

  report.packages = packages;
  report.repos = [...repos].sort((left, right) => left.localeCompare(right));

  return report;
}

function formatLastRun(lastRunAt) {
  if (!lastRunAt) {
    return 'n/a';
  }

  const parsed = new Date(lastRunAt);

  if (Number.isNaN(parsed.getTime())) {
    return 'n/a';
  }

  return parsed.toISOString();
}

function formatDirectRatio(report) {
  const direct = report.totals.directChanged;
  const transitive = report.totals.transitiveChanged;
  const total = direct + transitive;

  if (total === 0) {
    return '0 direct : 0 transitive';
  }

  const directPct = ((direct / total) * 100).toFixed(1);
  const transitivePct = ((transitive / total) * 100).toFixed(1);
  return `${direct} direct (${directPct}%) / ${transitive} transitive (${transitivePct}%)`;
}

function printHumanReport(report, { repoFilter = '', limit = 10 } = {}) {
  if (report.totals.runs === 0 && report.totals.changed === 0) {
    warn('No dependency delta metrics found yet. Run `bridge patch` to generate report data.');
    return;
  }

  printSummary(
    [
      `Patch runs: ${report.totals.runs}`,
      `Last run: ${formatLastRun(report.totals.lastRunAt)}`,
      `Changed packages: ${report.totals.changed}`,
      `Direct/transitive ratio: ${formatDirectRatio(report)}`,
      `Bumps: patch ${report.byBump.patch}, minor ${report.byBump.minor}, major ${report.byBump.major}, other ${report.byBump.other}`,
      `Security: ${report.security.auditedScopes} audited scopes, ${report.security.fixed} fixed, ${report.security.introduced} introduced`,
      `Bundles: ${report.bundles.checkedScopes} checked, ${report.bundles.increased} increased, ${report.bundles.decreased} decreased, ${report.bundles.thresholdExceeded} over threshold`,
      repoFilter ? `Repo filter: ${repoFilter}` : `Repos tracked: ${report.repos.length}`
    ],
    'Bridge report'
  );

  section(`Most-churned packages (top ${limit})`);

  if (report.packages.length === 0) {
    line('No changed packages found for the selected filter.');
    return;
  }

  for (const entry of report.packages) {
    const from = entry.lastFrom ?? 'null';
    const to = entry.lastTo ?? 'null';
    const manager = entry.manager || 'unknown';
    line(
      `- ${entry.name} [${manager}] updates=${entry.updates} kind=${entry.kind} last=${from} -> ${to} (${entry.lastBump})`
    );
  }
}

function formatRunStatus(status) {
  if (!status) {
    return 'unknown';
  }

  return String(status).replace(/_/g, ' ');
}

function formatRunSummary(report, reportPath) {
  const dependency = report.outcome?.dependencySummary;
  const failure = report.outcome?.failure;
  const artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
  const auditLines = (report.outcome?.audits || []).map((audit) => {
    const before = audit.before?.total;
    const after = audit.after?.total;
    return `Audit ${audit.scope}: ${before ?? 'n/a'} -> ${after ?? 'n/a'}`;
  });
  const bundleLines = (report.outcome?.bundles || [])
    .filter((bundle) => bundle.comparison)
    .map((bundle) => {
      const comparison = bundle.comparison;
      const sign = comparison.deltaBytes > 0 ? '+' : '';
      return `Bundle ${bundle.scope}: ${sign}${comparison.deltaBytes} bytes (${sign}${comparison.deltaPercent.toFixed(2)}% ${comparison.metric})`;
    });

  printSummary(
    [
      `Run: ${report.run?.id || 'unknown'}`,
      `Status: ${formatRunStatus(report.run?.status)}`,
      `Repository: ${report.target?.repository || 'unknown'}`,
      `Mode: ${report.execution?.dryRun ? 'dry run' : 'apply'}`,
      `Duration: ${report.run?.durationMs ?? 0}ms`,
      report.target?.baseBranch ? `Base: ${report.target.baseBranch}` : '',
      report.target?.candidateBranch ? `Candidate: ${report.target.candidateBranch}` : '',
      dependency
        ? `Dependencies: ${dependency.directChanged} direct, ${dependency.transitiveChanged} transitive`
        : 'Dependencies: not reached',
      `Files changed: ${report.outcome?.changedFilesCount ?? 0}`,
      ...auditLines,
      ...bundleLines,
      failure ? `Failure: ${failure.message}` : '',
      `Report: ${reportPath}`,
      artifacts.length > 0 ? `Artifacts: ${artifacts.length}` : ''
    ].filter(Boolean),
    'Bridge latest run'
  );

  if (failure?.command) {
    line(`Failed command: ${failure.command}`);
  }

  for (const artifact of artifacts) {
    line(`- ${artifact}`);
  }
}

export async function reportCommand({
  json = false,
  latest = false,
  repo = '',
  limit = 10
} = {}) {
  if (latest !== false) {
    const selectedRun = typeof latest === 'string' ? latest : '';
    const saved = await findSavedRunReport(selectedRun);

    if (!saved) {
      warn(
        selectedRun
          ? `No saved Bridge report found for run ${selectedRun}.`
          : 'No saved detailed Bridge run reports found yet.'
      );
      return false;
    }

    if (json) {
      line(JSON.stringify(saved.report, null, 2));
    } else {
      formatRunSummary(saved.report, saved.reportPath);
    }

    return true;
  }

  const logPath = getActivityLogPath();
  const entries = await readActivityEntries(logPath);
  const repoFilter = normalizeRepoFilter(repo);
  const topLimit = toPositiveInt(limit, 10);
  const report = buildReport(entries, { repoFilter, limit: topLimit });

  if (json) {
    line(JSON.stringify(report, null, 2));
    return true;
  }

  info(`Log file: ${logPath}`);
  printHumanReport(report, { repoFilter, limit: topLimit });
  return true;
}
