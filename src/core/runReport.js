import fs from 'node:fs/promises';
import path from 'node:path';

import { getActivityLogPath, getBridgeHome } from './activityLogger.js';
import { AGENT_TELEMETRY_SCHEMA_VERSION, getAgentEventStreamPath } from './agentTelemetry.js';
import { redactActivityPayload, redactSensitiveText } from './redaction.js';

export const RUN_REPORT_SCHEMA_VERSION = 'bridge-report.v1';

function parseLogLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function readRunEvents(runId) {
  try {
    const log = await fs.readFile(getActivityLogPath(), 'utf8');
    return log
      .split(/\r?\n/)
      .map(parseLogLine)
      .filter((event) => event?.runId === runId);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

export function getRunDirectory(runId) {
  return path.join(getBridgeHome(), 'runs', String(runId));
}

export function getRunReportPath(runId) {
  return path.join(getRunDirectory(runId), `${RUN_REPORT_SCHEMA_VERSION}.json`);
}

export function getRunFailurePath(runId) {
  return path.join(getRunDirectory(runId), 'failure.log');
}

function commandFailureDetails(error) {
  if (!error) {
    return null;
  }

  const details = {
    message: redactSensitiveText(error.message || String(error))
  };

  if (error.command) {
    details.command = redactSensitiveText(error.command);
  }

  if (Number.isInteger(error.code)) {
    details.exitCode = error.code;
  }

  return details;
}

export async function writeFailureEvidence(runId, error) {
  const details = commandFailureDetails(error);

  if (!details) {
    return '';
  }

  const lines = [
    `Bridge run failure: ${details.message}`,
    details.command ? `Command: ${details.command}` : '',
    Number.isInteger(details.exitCode) ? `Exit code: ${details.exitCode}` : '',
    ''
  ].filter(Boolean);

  if (error?.stderr) {
    lines.push('--- stderr ---', redactSensitiveText(error.stderr), '');
  }

  if (error?.stdout) {
    lines.push('--- stdout ---', redactSensitiveText(error.stdout), '');
  }

  const failurePath = getRunFailurePath(runId);
  await fs.mkdir(path.dirname(failurePath), { recursive: true });
  await fs.writeFile(failurePath, `${lines.join('\n')}\n`, 'utf8');
  return failurePath;
}

function summarizeAudits(results = []) {
  return results
    .filter(Boolean)
    .map((entry) => ({
      scope: entry.label,
      before: entry.before?.counts || null,
      after: entry.after?.counts || null,
      comparison: entry.comparison || null
    }));
}

function emptyDependencySummary() {
  return {
    totalChanged: 0,
    added: 0,
    removed: 0,
    directChanged: 0,
    transitiveChanged: 0,
    byBump: { patch: 0, minor: 0, major: 0, other: 0 }
  };
}

function dependencySummaryFromEvents(events) {
  const summary = emptyDependencySummary();

  for (const event of events) {
    if (event.event !== 'dep_delta') {
      continue;
    }

    summary.totalChanged += 1;

    if (event.from === null || event.from === undefined) {
      summary.added += 1;
    }

    if (event.to === null || event.to === undefined) {
      summary.removed += 1;
    }

    if (event.kind === 'direct') {
      summary.directChanged += 1;
    } else {
      summary.transitiveChanged += 1;
    }

    if (Object.prototype.hasOwnProperty.call(summary.byBump, event.bump)) {
      summary.byBump[event.bump] += 1;
    } else {
      summary.byBump.other += 1;
    }
  }

  return summary;
}

function auditComparisonFromCounts(before, after) {
  if (!before || !after) {
    return null;
  }

  const severities = ['info', 'low', 'moderate', 'high', 'critical', 'total'];
  const delta = Object.fromEntries(
    severities.map((severity) => [
      severity,
      (after[severity] || 0) - (before[severity] || 0)
    ])
  );

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

function auditsFromEvents(events) {
  const byScope = new Map();

  for (const event of events) {
    if (
      event.event !== 'phase' ||
      !event.counts ||
      typeof event.phase !== 'string' ||
      (!event.phase.startsWith('audit_before:') && !event.phase.startsWith('audit_after:'))
    ) {
      continue;
    }

    const scope = event.scope || event.phase.split(':').slice(1).join(':') || 'root';
    const entry = byScope.get(scope) || { scope, before: null, after: null };

    if (event.phase.startsWith('audit_before:')) {
      entry.before = event.counts;
    } else {
      entry.after = event.counts;
    }

    byScope.set(scope, entry);
  }

  return [...byScope.values()].map((entry) => ({
    ...entry,
    comparison: auditComparisonFromCounts(entry.before, entry.after)
  }));
}

function summarizeBundles(results = []) {
  return results
    .filter(Boolean)
    .map((entry) => ({
      scope: entry.label,
      beforeArtifact: entry.before?.artifactPath || '',
      afterArtifact: entry.after?.artifactPath || '',
      comparison: entry.comparison || null
    }));
}

function bundlesFromEvents(events) {
  const byScope = new Map();

  for (const event of events) {
    if (event.event !== 'phase' || typeof event.phase !== 'string') {
      continue;
    }

    const isBundlePhase =
      event.phase.startsWith('bundle_before:') ||
      event.phase.startsWith('bundle_after:') ||
      event.phase.startsWith('bundle_comparison:');

    if (!isBundlePhase) {
      continue;
    }

    const scope = event.scope || event.phase.split(':').slice(1).join(':') || 'root';
    const entry = byScope.get(scope) || {
      scope,
      beforeArtifact: '',
      afterArtifact: '',
      comparison: null
    };

    if (event.phase.startsWith('bundle_before:')) {
      entry.beforeArtifact = event.artifactPath || '';
    } else if (event.phase.startsWith('bundle_after:')) {
      entry.afterArtifact = event.artifactPath || '';
    } else {
      entry.comparison = {
        metric: event.metric,
        beforeBytes: event.beforeBytes,
        afterBytes: event.afterBytes,
        deltaBytes: event.deltaBytes,
        deltaPercent: event.deltaPercent,
        regressed: event.regressed,
        thresholdExceeded: event.thresholdExceeded,
        percentExceeded: event.percentExceeded,
        bytesExceeded: event.bytesExceeded
      };
    }

    byScope.set(scope, entry);
  }

  return [...byScope.values()];
}

function collectArtifactPaths(events = [], failurePath = '') {
  const artifacts = new Set();

  for (const event of events) {
    if (typeof event.artifactPath === 'string' && event.artifactPath) {
      artifacts.add(event.artifactPath);
    }
  }

  if (failurePath) {
    artifacts.add(failurePath);
  }

  return [...artifacts];
}

function getEnvironmentInfo() {
  return {
    nodeVersion: process.version,
    npmVersion: process.env.npm_config_user_agent
      ? process.env.npm_config_user_agent.split(' ')[0]?.split('/')[1] || null
      : null,
    platform: process.platform,
    arch: process.arch
  };
}

function summarizeValidation(results = []) {
  return results
    .filter(Boolean)
    .map((entry) => ({
      scope: entry.label || 'root',
      scriptDiff: entry.scriptDiff || null,
      hasNewFailures: entry.comparison?.hasNewFailures || false,
      hasBaselineNoise: entry.comparison?.hasBaselineNoise || false,
      newFailureCount: entry.comparison?.newFailureCount || 0,
      baselineFailureCount: entry.comparison?.baselineFailureCount || 0,
      resolvedCount: entry.comparison?.resolvedCount || 0
    }));
}

function collectGateDecisions(auditResults, validationResults) {
  const decisions = [];

  for (const audit of auditResults || []) {
    if (audit?.comparison?.blocked) {
      decisions.push({
        gate: 'audit',
        scope: audit.label || 'root',
        passed: false,
        reason: audit.comparison.blockReason
      });
    } else if (audit?.comparison?.comparable) {
      decisions.push({
        gate: 'audit',
        scope: audit.label || 'root',
        passed: true,
        reason: 'No blocking severity increases'
      });
    }
  }

  for (const validation of validationResults || []) {
    if (validation?.comparison?.hasNewFailures) {
      decisions.push({
        gate: 'validation',
        scope: validation.label || 'root',
        passed: false,
        reason: `${validation.comparison.newFailureCount} new script failure(s)`
      });
    } else {
      decisions.push({
        gate: 'validation',
        scope: validation.label || 'root',
        passed: true,
        reason: validation.comparison?.hasBaselineNoise
          ? 'Only baseline failures (unchanged)'
          : 'All scripts passed'
      });
    }
  }

  return decisions;
}

export async function writeRunReport({
  run,
  status,
  repo = '',
  configPath = '',
  dryRun = false,
  keepWorkspace = false,
  requestedScope = '',
  branchName = '',
  baseBranch = '',
  baseSha = '',
  headSha = '',
  stagedFiles = [],
  changedFilesCount = 0,
  dependencySummary = null,
  auditResults = [],
  bundleResults = [],
  validationResults = [],
  localPackages = [],
  pullRequest = null,
  failure = null,
  failurePath = '',
  configFileSha256 = '',
  configStaged = false,
  configMutated = false,
  earlyExit = null,
  phaseTiming = {},
  skippedCount = 0,
  blockedCount = 0
} = {}) {
  const events = await readRunEvents(run.runId);
  const finishedEvent = [...events].reverse().find((event) => event.event === 'run_finished');
  const derivedDependencySummary = dependencySummaryFromEvents(events);
  const hasProvidedDependencyChanges = Number(dependencySummary?.totalChanged) > 0;
  const resolvedDependencySummary = hasProvidedDependencyChanges
    ? dependencySummary
    : derivedDependencySummary;
  const resolvedAudits =
    auditResults.length > 0 ? summarizeAudits(auditResults) : auditsFromEvents(events);
  const resolvedBundles =
    bundleResults.length > 0 ? summarizeBundles(bundleResults) : bundlesFromEvents(events);
  const resolvedValidation = summarizeValidation(validationResults);
  const gateDecisions = collectGateDecisions(auditResults, validationResults);

  const agentEventStreamPath = getAgentEventStreamPath(run.runId);

  const report = redactActivityPayload({
    schemaVersion: RUN_REPORT_SCHEMA_VERSION,
    agentSchemaVersion: AGENT_TELEMETRY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    run: {
      id: run.runId,
      command: run.command,
      status,
      startedAt: new Date(run.startedAtMs).toISOString(),
      finishedAt: finishedEvent?.at || new Date().toISOString(),
      durationMs: Date.now() - run.startedAtMs
    },
    environment: getEnvironmentInfo(),
    target: {
      repository: repo,
      configPath,
      baseBranch,
      candidateBranch: branchName,
      scope: requestedScope || 'all'
    },
    git: {
      baseBranch,
      branchName,
      baseSha: baseSha || '',
      headSha: headSha || '',
      stagedFiles: stagedFiles || []
    },
    config: {
      path: configPath,
      sha256: configFileSha256 || '',
      staged: configStaged,
      mutated: configMutated
    },
    execution: {
      dryRun,
      keptWorkspace: keepWorkspace,
      localPackages: localPackages.map((entry) => ({
        name: entry.name,
        path: entry.path,
        version: entry.version || ''
      }))
    },
    outcome: {
      changedFilesCount,
      dependencySummary: resolvedDependencySummary,
      audits: resolvedAudits,
      bundles: resolvedBundles,
      validation: resolvedValidation,
      gateDecisions,
      pullRequest,
      failure: commandFailureDetails(failure),
      earlyExit: earlyExit || null,
      skippedCount: skippedCount || 0,
      blockedCount: blockedCount || 0
    },
    phaseTiming: phaseTiming || {},
    phases: events
      .filter((event) => event.event === 'phase')
      .map(({ event, at, runId, command, ...phase }) => ({ at, ...phase })),
    artifacts: collectArtifactPaths(events, failurePath),
    agentEventStream: agentEventStreamPath
  });

  const reportPath = getRunReportPath(run.runId);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, reportPath };
}

export async function findSavedRunReport(runId = '') {
  const runsDir = path.join(getBridgeHome(), 'runs');
  let entries = [];

  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && (!runId || entry.name === runId))
    .map((entry) => ({
      reportPath: getRunReportPath(entry.name)
    }));
  const readable = [];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate.reportPath);
      readable.push({ ...candidate, modifiedMs: stat.mtimeMs });
    } catch {
      // A partial run directory is not a saved report.
    }
  }

  readable.sort((left, right) => right.modifiedMs - left.modifiedMs);
  const latest = readable[0];

  if (!latest) {
    return null;
  }

  return {
    reportPath: latest.reportPath,
    report: JSON.parse(await fs.readFile(latest.reportPath, 'utf8'))
  };
}
