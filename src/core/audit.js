import { runCommand } from './executor.js';

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

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

export function compareAuditSnapshots(before, after) {
  if (!before?.parsed || !after?.parsed) {
    return {
      comparable: false,
      regressed: false,
      improvements: 0,
      regressions: 0,
      delta: emptyCounts()
    };
  }

  const delta = emptyCounts();

  for (const severity of [...SEVERITIES, 'total']) {
    delta[severity] = after.counts[severity] - before.counts[severity];
  }

  return {
    comparable: true,
    regressed:
      delta.total > 0 ||
      delta.critical > 0 ||
      delta.high > 0 ||
      delta.moderate > 0 ||
      delta.low > 0,
    improvements: Math.max(0, -delta.total),
    regressions: Math.max(0, delta.total),
    delta
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
