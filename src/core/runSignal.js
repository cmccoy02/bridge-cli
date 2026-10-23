export const RUN_SIGNAL_SCHEMA_VERSION = 'bridge-time-saved.v1';

function asCount(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) {
      return value;
    }
  }

  return 0;
}

export function classifyPrAction(pullRequest) {
  const status = String(pullRequest?.status || '').trim();

  if (status === 'created') {
    return 'created';
  }

  if (status === 'updated' || status === 'existing') {
    return status === 'existing' && pullRequest?.reused === true ? 'reused' : 'updated';
  }

  if (status === 'reused' || pullRequest?.reused === true) {
    return 'reused';
  }

  return status || 'none';
}

export function buildRunSignal({
  run = {},
  status = '',
  repo = '',
  dependencySummary = null,
  scriptSummary = null,
  pullRequest = null,
  performance = null,
  durationMs = null
} = {}) {
  const totals = scriptSummary?.totals || {};
  const packagesUpdated = asCount(dependencySummary?.totalChanged);

  return {
    schemaVersion: RUN_SIGNAL_SCHEMA_VERSION,
    runId: run.runId || run.id || '',
    repo: repo || '',
    outcome: status || run.status || '',
    durationMs: asCount(durationMs, performance?.durationMs, run.durationMs),
    packagesUpdated,
    directUpdated: asCount(dependencySummary?.directChanged),
    transitiveUpdated: asCount(dependencySummary?.transitiveChanged),
    scriptsRun: asCount(totals.scripts),
    scriptsPassed: asCount(totals.passed),
    scriptsFailed: asCount(totals.failed),
    prAction: classifyPrAction(pullRequest),
    prUrl: pullRequest?.url || '',
    peakRssBytes: asCount(performance?.peakRssBytes),
    cpuUserMs: asCount(performance?.cpuUserMs),
    cpuSystemMs: asCount(performance?.cpuSystemMs)
  };
}
