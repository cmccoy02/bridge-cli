import { DEFAULT_NOTIFY_ON } from '../bridgeSettings.js';
import { getBridgeVersion } from '../bridgeVersion.js';
import { classifyPrAction } from '../runSignal.js';

export { DEFAULT_NOTIFY_ON };

export const NOTIFY_SCHEMA = 'bridge-notify.v1';

export const NOTIFY_OUTCOMES = [
  'pr_created',
  'pr_updated',
  'pr_reused',
  'no_updates',
  'blocked',
  'error'
];

export const HEARTBEAT_OUTCOMES = ['no_updates', 'pr_reused'];

export const EMPTY_SECURITY_COUNTS = Object.freeze({
  info: 0,
  low: 0,
  moderate: 0,
  high: 0,
  critical: 0,
  total: 0
});

const BLOCKED_CODES = new Set([
  'policy_block',
  'audit_block',
  'bundle_block',
  'validation_block',
  'pr_lookup_failed'
]);

const AGGREGATE_ORDER = [
  'error',
  'blocked',
  'pr_created',
  'pr_updated',
  'pr_reused',
  'no_updates'
];

function asCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function countsFrom(side) {
  const source = side?.counts && typeof side.counts === 'object' ? side.counts : side;
  if (!source || typeof source !== 'object') {
    return { ...EMPTY_SECURITY_COUNTS };
  }

  return {
    info: asCount(source.info),
    low: asCount(source.low),
    moderate: asCount(source.moderate),
    high: asCount(source.high),
    critical: asCount(source.critical),
    total: asCount(source.total)
  };
}

function addCounts(left, right) {
  const result = { ...EMPTY_SECURITY_COUNTS };
  for (const key of Object.keys(result)) {
    result[key] = asCount(left?.[key]) + asCount(right?.[key]);
  }
  return result;
}

export function securityFromAudits(audits = []) {
  let before = { ...EMPTY_SECURITY_COUNTS };
  let after = { ...EMPTY_SECURITY_COUNTS };

  for (const audit of audits || []) {
    before = addCounts(before, countsFrom(audit?.before));
    after = addCounts(after, countsFrom(audit?.after));
  }

  return { before, after };
}

export function packagesFromSummary(summary = {}) {
  const byBump = summary?.byBump || {};
  return {
    direct: asCount(summary?.directChanged),
    transitive: asCount(summary?.transitiveChanged),
    patch: asCount(byBump.patch),
    minor: asCount(byBump.minor),
    major: asCount(byBump.major)
  };
}

function earlyCodeOf(report) {
  const early = report?.outcome?.earlyExit;
  if (typeof early === 'string') {
    return early;
  }

  return String(early?.code || '');
}

export function classifyNotifyOutcome(report = {}) {
  const action = classifyPrAction(report?.outcome?.pullRequest);
  if (action === 'created') {
    return 'pr_created';
  }
  if (action === 'reused') {
    return 'pr_reused';
  }
  if (action === 'updated' || action === 'existing') {
    return 'pr_updated';
  }

  const status = String(report?.run?.status || '');
  const earlyCode = earlyCodeOf(report);
  const blockedCount = asCount(report?.outcome?.blockedCount);
  const failedGate = (report?.outcome?.gateDecisions || []).some(
    (decision) => decision && decision.passed === false
  );

  if (
    status === 'up_to_date' ||
    earlyCode === 'no_updates' ||
    earlyCode === 'up_to_date'
  ) {
    return 'no_updates';
  }

  if (blockedCount > 0 || failedGate || BLOCKED_CODES.has(earlyCode)) {
    return 'blocked';
  }

  if (status === 'dry_run') {
    return 'no_updates';
  }

  if (status === 'failed' || status === 'cancelled' || status === 'failed_preflight') {
    return 'error';
  }

  return 'error';
}

function blockedReasonFrom(report, outcome) {
  if (outcome !== 'blocked' && outcome !== 'error') {
    return '';
  }

  const early = report?.outcome?.earlyExit;
  const message =
    (typeof early === 'object' && early?.message) ||
    report?.outcome?.failure?.message ||
    (typeof early === 'string' ? early : '') ||
    '';

  return String(message).split('\n')[0].trim();
}

export function prNumberFromUrl(url = '') {
  const match = String(url || '').match(/\/pulls?\/(\d+)/);
  return match ? match[1] : '';
}

export function outcomeHeader(event = {}) {
  const outcome = event.outcome;
  if (event.kind === 'batch') {
    const emoji =
      {
        pr_created: '✅',
        pr_updated: '🔄',
        pr_reused: '🔁',
        no_updates: '⚪',
        blocked: '⛔',
        error: '❌'
      }[outcome] || '📋';
    return `${emoji} Bridge digest`;
  }

  if (outcome === 'pr_created') {
    return '✅ PR opened';
  }
  if (outcome === 'pr_updated') {
    return '🔄 PR updated';
  }
  if (outcome === 'pr_reused') {
    const number = prNumberFromUrl(event.prUrl);
    return number ? `🔁 Reused #${number}` : '🔁 Reused PR';
  }
  if (outcome === 'no_updates') {
    return '⚪ No updates';
  }
  if (outcome === 'blocked') {
    return '⛔ Blocked';
  }
  if (outcome === 'error') {
    return '❌ Error';
  }

  return String(outcome || 'Bridge result');
}

export function aggregateOutcomes(outcomes = []) {
  for (const candidate of AGGREGATE_ORDER) {
    if (outcomes.includes(candidate)) {
      return candidate;
    }
  }

  return 'no_updates';
}

function outcomeFromRepoEntry(entry = {}) {
  if (entry.prAction === 'created') {
    return 'pr_created';
  }
  if (entry.prAction === 'reused') {
    return 'pr_reused';
  }
  if (entry.prAction === 'updated' || entry.prAction === 'existing') {
    return 'pr_updated';
  }

  const status = String(entry.status || '');
  const reason = String(entry.failureReason || '');
  if (BLOCKED_CODES.has(status) || /block|policy|audit|validation|gate/i.test(reason)) {
    return 'blocked';
  }
  if (/fail|cancel/i.test(status) || reason) {
    return 'error';
  }
  if (status === 'up_to_date' || status === 'dry_run') {
    return 'no_updates';
  }

  return 'no_updates';
}

export function buildNotifyEventFromReport(report = {}, extras = {}) {
  const outcome = classifyNotifyOutcome(report);
  const packages = packagesFromSummary(report?.outcome?.dependencySummary);
  const security = securityFromAudits(report?.outcome?.audits);

  return {
    schema: NOTIFY_SCHEMA,
    kind: 'run',
    repo: report?.target?.repository || extras.repo || '',
    baseBranch:
      report?.target?.baseBranch || report?.git?.baseBranch || extras.baseBranch || '',
    outcome,
    prUrl: report?.outcome?.pullRequest?.url || '',
    packages,
    security,
    blockedReason: blockedReasonFrom(report, outcome),
    runId: report?.run?.id || extras.runId || '',
    durationMs: asCount(report?.run?.durationMs || extras.durationMs),
    bridgeVersion: extras.bridgeVersion || getBridgeVersion(),
    reportPath: extras.reportPath || '',
    batchId: extras.batchId || report?.run?.batchId || ''
  };
}

export function buildNotifyEventFromBatch({
  daily,
  bridgeVersion = getBridgeVersion()
} = {}) {
  const model = daily?.model || {};
  const repos = (model.repos || []).map((entry) => {
    const packages = packagesFromSummary({
      directChanged: entry.packagesUpdated,
      transitiveChanged: 0,
      byBump: {}
    });
    if (typeof entry.packages === 'object' && entry.packages) {
      packages.direct = asCount(entry.packages.direct ?? packages.direct);
      packages.transitive = asCount(entry.packages.transitive ?? packages.transitive);
    }

    return {
      repo: entry.repo || '',
      outcome: outcomeFromRepoEntry(entry),
      prUrl: entry.prUrl || '',
      packages,
      blockedReason: entry.failureReason || '',
      runId: entry.runId || '',
      durationMs: asCount(entry.durationMs)
    };
  });

  const packages = repos.reduce(
    (sum, entry) => ({
      direct: sum.direct + asCount(entry.packages?.direct),
      transitive: sum.transitive + asCount(entry.packages?.transitive),
      patch: sum.patch + asCount(entry.packages?.patch),
      minor: sum.minor + asCount(entry.packages?.minor),
      major: sum.major + asCount(entry.packages?.major)
    }),
    { direct: 0, transitive: 0, patch: 0, minor: 0, major: 0 }
  );

  return {
    schema: NOTIFY_SCHEMA,
    kind: 'batch',
    repo: repos.map((entry) => entry.repo).filter(Boolean).join(', ') || 'batch',
    baseBranch: '',
    outcome: aggregateOutcomes(repos.map((entry) => entry.outcome)),
    prUrl: repos.find((entry) => entry.prUrl)?.prUrl || '',
    packages,
    security: {
      before: { ...EMPTY_SECURITY_COUNTS },
      after: { ...EMPTY_SECURITY_COUNTS }
    },
    blockedReason: repos.find((entry) => entry.blockedReason)?.blockedReason || '',
    runId: model.batch?.id || '',
    durationMs: asCount(model.totals?.wallMs || model.batch?.performance?.wallMs),
    bridgeVersion,
    reportPath: daily?.latestPath || '',
    summaryText: daily?.text || '',
    repos
  };
}

export function buildSampleNotifyEvent() {
  return {
    schema: NOTIFY_SCHEMA,
    kind: 'test',
    repo: 'acme/app',
    baseBranch: 'main',
    outcome: 'pr_created',
    prUrl: 'https://github.com/acme/app/pull/1',
    packages: { direct: 2, transitive: 5, patch: 4, minor: 2, major: 1 },
    security: {
      before: { info: 0, low: 0, moderate: 1, high: 2, critical: 1, total: 4 },
      after: { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 }
    },
    blockedReason: '',
    runId: 'notify-test',
    durationMs: 0,
    bridgeVersion: getBridgeVersion(),
    reportPath: ''
  };
}

export function isBatchMember(event = {}, env = process.env) {
  if (event.kind === 'batch' || event.kind === 'test') {
    return false;
  }

  return Boolean(event.batchId || String(env.BRIDGE_BATCH_ID || '').trim());
}

export function isOutcomeEnabled(outcome, settings = {}) {
  const enabled = Array.isArray(settings?.notifications?.on)
    ? settings.notifications.on
    : DEFAULT_NOTIFY_ON;
  return enabled.includes(outcome);
}

export function formatSecurityDelta(security = {}) {
  const before = security.before || {};
  const after = security.after || {};
  return ['critical', 'high', 'total']
    .map((key) => {
      const label = key === 'critical' ? 'crit' : key;
      return `${label} ${before[key] || 0}→${after[key] || 0}`;
    })
    .join('  ');
}
