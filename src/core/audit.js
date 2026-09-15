import { runCommand } from './executor.js';

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
export const BLOCKING_SEVERITIES = ['critical', 'high'];

function emptyCounts() {
  return {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0
  };
}

function normalizeCounts(counts = {}) {
  const normalized = emptyCounts();

  for (const severity of SEVERITIES) {
    const value = Number(counts?.[severity]);
    normalized[severity] = Number.isFinite(value) && value >= 0 ? value : 0;
  }

  const reportedTotal = Number(counts?.total);
  normalized.total =
    Number.isFinite(reportedTotal) && reportedTotal >= 0
      ? reportedTotal
      : SEVERITIES.reduce((sum, severity) => sum + normalized[severity], 0);

  return normalized;
}

export function parseNpmAuditJson(raw) {
  const parsed = JSON.parse(String(raw || '').trim());
  const counts = normalizeCounts(parsed?.metadata?.vulnerabilities);

  return {
    format: 'npm-audit-v2',
    counts
  };
}

export function defaultAuditCommand(packageManager) {
  if (packageManager === 'npm') {
    return 'npm audit --package-lock-only --json';
  }

  return '';
}

export async function captureAuditSnapshot({
  cwd,
  packageManager,
  auditCommand = '',
  quiet = true
}) {
  const command = auditCommand || defaultAuditCommand(packageManager);

  if (!command) {
    return {
      supported: false,
      parsed: false,
      command: '',
      counts: emptyCounts(),
      error: ''
    };
  }

  const result = await runCommand(command, {
    cwd,
    allowFailure: true,
    quiet
  });
  const raw = result.stdout.trim() || result.stderr.trim();

  try {
    const parsed = parseNpmAuditJson(raw);
    return {
      supported: true,
      parsed: true,
      command,
      exitCode: result.code,
      counts: parsed.counts,
      error: ''
    };
  } catch (error) {
    return {
      supported: true,
      parsed: false,
      command,
      exitCode: result.code,
      counts: emptyCounts(),
      error: `Could not parse vulnerability audit output: ${error.message}`
    };
  }
}

export function compareAuditSnapshots(before, after, options = {}) {
  if (!before?.parsed || !after?.parsed) {
    return {
      comparable: false,
      regressed: false,
      blocked: false,
      blockReason: '',
      improvements: 0,
      regressions: 0,
      delta: emptyCounts(),
      severityDeltas: {}
    };
  }

  const blockingSeverities = options.blockingSeverities || BLOCKING_SEVERITIES;
  const delta = emptyCounts();
  const severityDeltas = {};

  for (const severity of [...SEVERITIES, 'total']) {
    const change = after.counts[severity] - before.counts[severity];
    delta[severity] = change;
    severityDeltas[severity] = {
      before: before.counts[severity],
      after: after.counts[severity],
      delta: change
    };
  }

  const regressed =
    delta.total > 0 ||
    delta.critical > 0 ||
    delta.high > 0 ||
    delta.moderate > 0 ||
    delta.low > 0;

  const blockingIncreases = blockingSeverities.filter(
    (severity) => delta[severity] > 0
  );
  const blocked = blockingIncreases.length > 0;
  const blockReason = blocked
    ? `Increased vulnerabilities: ${blockingIncreases.map((s) => `${s} +${delta[s]}`).join(', ')}`
    : '';

  return {
    comparable: true,
    regressed,
    blocked,
    blockReason,
    blockingSeverities,
    improvements: Math.max(0, -delta.total),
    regressions: Math.max(0, delta.total),
    delta,
    severityDeltas
  };
}

export function formatAuditCounts(snapshot) {
  if (!snapshot?.supported) {
    return 'not configured';
  }

  if (!snapshot.parsed) {
    return 'unavailable';
  }

  const { counts } = snapshot;
  return `${counts.total} total (${counts.critical} critical / ${counts.high} high / ${counts.moderate} moderate / ${counts.low} low)`;
}

export function formatAuditDelta(comparison) {
  if (!comparison?.comparable) {
    return 'Audit comparison: not available';
  }

  const { delta, severityDeltas } = comparison;
  const parts = [];

  for (const severity of SEVERITIES) {
    const d = delta[severity];
    if (d !== 0) {
      const sign = d > 0 ? '+' : '';
      parts.push(`${severity}: ${sign}${d}`);
    }
  }

  if (parts.length === 0) {
    return 'Audit delta: no change';
  }

  const totalSign = delta.total > 0 ? '+' : '';
  return `Audit delta: ${totalSign}${delta.total} total (${parts.join(', ')})`;
}

export function formatAuditComparison(before, after, comparison) {
  if (!comparison?.comparable) {
    return 'Audit: comparison not available';
  }

  const beforeStr = formatAuditCounts(before);
  const afterStr = formatAuditCounts(after);
  const deltaStr = formatAuditDelta(comparison);

  return `Before: ${beforeStr}\nAfter: ${afterStr}\n${deltaStr}`;
}

export function createAuditComparisonReport(before, after, comparison) {
  return {
    before: before?.counts || null,
    after: after?.counts || null,
    delta: comparison?.delta || null,
    severityDeltas: comparison?.severityDeltas || null,
    comparable: comparison?.comparable || false,
    regressed: comparison?.regressed || false,
    blocked: comparison?.blocked || false,
    blockReason: comparison?.blockReason || ''
  };
}
