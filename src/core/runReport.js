import fs from 'node:fs/promises';
import path from 'node:path';

import { getActivityLogPath, getBridgeHome, getRunOperationsLogPath } from './activityLogger.js';
import { AGENT_TELEMETRY_SCHEMA_VERSION, getAgentEventStreamPath } from './agentTelemetry.js';
import { redactActivityPayload, redactSensitiveText } from './redaction.js';
import { buildRunSignal } from './runSignal.js';
import { formatValidationGateReason } from './scriptDiff.js';
import {
  buildScriptSummary,
  buildScriptSummaryRows,
  getRunSummaryPath,
  writeRunSummaryFile
} from './scriptSummary.js';

export const RUN_REPORT_SCHEMA_VERSION = 'bridge-report.v1';

function parseLogLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function readJsonl(filePath) {
  const log = await fs.readFile(filePath, 'utf8');
  return log.split(/\r?\n/).map(parseLogLine).filter(Boolean);
}

async function readRunEvents(runId) {
  try {
    return (await readJsonl(getRunOperationsLogPath(runId))).filter(
      (event) => event?.runId === runId
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    return (await readJsonl(getActivityLogPath())).filter((event) => event?.runId === runId);
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

export { getRunSummaryPath };

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

  if (error.stdout) {
    details.stdout = redactSensitiveText(error.stdout);
  }

  if (error.stderr) {
    details.stderr = redactSensitiveText(error.stderr);
  }

  if (error.gateType) {
    details.gateType = error.gateType;
  }

  return details;
}

function appendCommandStreams(lines, failure, heading = '') {
  if (heading) {
    lines.push(heading, '');
  }

  if (failure?.command) {
    lines.push(`Command: ${redactSensitiveText(failure.command)}`);
  }

  if (Number.isInteger(failure?.code ?? failure?.exitCode)) {
    lines.push(`Exit code: ${failure.code ?? failure.exitCode}`);
  }

  if (Array.isArray(failure?.addedErrorLines) && failure.addedErrorLines.length > 0) {
    lines.push('Added error lines:');
    for (const added of failure.addedErrorLines) {
      lines.push(`  ${redactSensitiveText(added)}`);
    }
  }

  if (failure?.stderr) {
    lines.push('--- stderr ---', redactSensitiveText(failure.stderr), '');
  }

  if (failure?.stdout) {
    lines.push('--- stdout ---', redactSensitiveText(failure.stdout), '');
  }

  if (!failure?.stderr && !failure?.stdout && failure?.output) {
    lines.push('--- output ---', redactSensitiveText(failure.output), '');
  }
}

export async function writeFailureEvidence(runId, error) {
  const details = commandFailureDetails(error);

  if (!details) {
    return '';
  }

  const extraFailures = Array.isArray(error?.failures)
    ? error.failures.filter(Boolean)
    : [];
  const lines = [
    `Bridge run failure: ${details.message}`,
    details.command ? `Command: ${details.command}` : '',
    Number.isInteger(details.exitCode) ? `Exit code: ${details.exitCode}` : '',
    ''
  ].filter(Boolean);

  if (Array.isArray(error?.addedErrorLines) && error.addedErrorLines.length > 0) {
    lines.push('Added error lines:');
    for (const added of error.addedErrorLines) {
      lines.push(`  ${redactSensitiveText(added)}`);
    }
    lines.push('');
  }

  if (error?.stderr) {
    lines.push('--- stderr ---', redactSensitiveText(error.stderr), '');
  }

  if (error?.stdout) {
    lines.push('--- stdout ---', redactSensitiveText(error.stdout), '');
  }

  if (!error?.stderr && !error?.stdout && error?.output) {
    lines.push('--- output ---', redactSensitiveText(error.output), '');
  }

  const extraToWrite = extraFailures.filter((failure) => {
    if (!failure?.command) {
      return Boolean(failure?.stdout || failure?.stderr || failure?.output);
    }

    return failure.command !== error?.command;
  });

  for (const [index, failure] of extraToWrite.entries()) {
    appendCommandStreams(
      lines,
      failure,
      `--- failing command ${index + 1} ---`
    );
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
      resolvedCount: entry.comparison?.resolvedCount || 0,
      skipBeforeScripts: entry.skipBeforeScripts === true,
      afterScriptsRan: entry.afterScriptsRan === true
    }));
}

export function scriptSummaryFromValidation(
  validationResults = [],
  { skipBeforeScripts = false, earlyExit = null } = {}
) {
  const rows = [];
  let afterScriptsRan = false;

  for (const entry of validationResults || []) {
    const afterResults = Array.isArray(entry.afterResults)
      ? entry.afterResults
      : (entry.scriptDiff?.after?.scripts || []).map((script) => ({
          command: script.command,
          success: script.success,
          durationMs: script.durationMs,
          exitCode: script.exitCode,
          logPath: script.logPath || ''
        }));

    if (entry.afterScriptsRan === true || afterResults.length > 0) {
      afterScriptsRan = afterScriptsRan || entry.afterScriptsRan !== false;
    }

    rows.push(
      ...buildScriptSummaryRows({
        scope: entry.label || 'root',
        afterResults,
        comparison: entry.comparison,
        ran: entry.afterScriptsRan !== false && afterResults.length > 0
      })
    );
  }

  return buildScriptSummary({
    skipBeforeScripts:
      skipBeforeScripts === true ||
      (validationResults || []).some((entry) => entry.skipBeforeScripts === true),
    afterScriptsRan,
    earlyExit: typeof earlyExit === 'string' ? earlyExit : earlyExit?.code || null,
    rows
  });
}

function collectGateDecisions(auditResults, validationResults, bundleResults) {
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
    if (!validation?.comparison) {
      continue;
    }

    const blocked =
      validation.blocked === true || validation.comparison.hasNewFailures;
    decisions.push({
      gate: 'validation',
      scope: validation.label || 'root',
      passed: !blocked,
      reason: formatValidationGateReason(validation.comparison, {
        blockOnBaselineFailures: validation.blockOnBaselineFailures === true
      })
    });
  }

  for (const bundle of bundleResults || []) {
    if (!bundle?.comparison) {
      continue;
    }

    decisions.push({
      gate: 'bundle',
      scope: bundle.label || 'root',
      passed: !bundle.comparison.thresholdExceeded,
      reason: bundle.comparison.thresholdExceeded
        ? `Bundle size increased by ${Number(bundle.comparison.deltaPercent || 0).toFixed(2)}%`
        : 'Bundle size within threshold'
    });
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
  blockedCount = 0,
  environment = null,
  scriptSummary = null,
  skipBeforeScripts = false,
  performance = null
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
  const resolvedScriptSummary =
    scriptSummary ||
    scriptSummaryFromValidation(validationResults, {
      skipBeforeScripts,
      earlyExit
    });
  const gateDecisions = collectGateDecisions(auditResults, validationResults, bundleResults);
  const failedGates = gateDecisions.filter((decision) => !decision.passed).length;
  const resolvedBlockedCount = Math.max(blockedCount || 0, failedGates);

  const agentEventStreamPath = getAgentEventStreamPath(run.runId);
  const resolvedEnvironment = environment || getEnvironmentInfo();
  const resolvedDurationMs = Date.now() - run.startedAtMs;
  const resolvedPerformance = performance
    ? { ...performance, durationMs: performance.durationMs || resolvedDurationMs }
    : { durationMs: resolvedDurationMs };
  const timeSaved = buildRunSignal({
    run: { ...run, durationMs: resolvedDurationMs },
    status,
    repo,
    dependencySummary: resolvedDependencySummary,
    scriptSummary: resolvedScriptSummary,
    pullRequest,
    performance: resolvedPerformance,
    durationMs: resolvedDurationMs
  });

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
      durationMs: resolvedDurationMs,
      pid: run.pid || process.pid
    },
    environment: resolvedEnvironment,
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
      scriptSummary: resolvedScriptSummary,
      gateDecisions,
      pullRequest,
      failure: commandFailureDetails(failure),
      earlyExit: earlyExit || null,
      skippedCount: skippedCount || 0,
      blockedCount: resolvedBlockedCount
    },
    performance: resolvedPerformance,
    timeSaved,
    phaseTiming: phaseTiming || {},
    phases: events
      .filter((event) => event.event === 'phase')
      .map(({ event, at, runId, command, ...phase }) => ({ at, ...phase })),
    artifacts: [
      ...collectArtifactPaths(events, failurePath),
      ...resolvedScriptSummary.scripts
        .map((row) => row.logPath)
        .filter((logPath) => typeof logPath === 'string' && logPath)
    ],
    agentEventStream: agentEventStreamPath
  });

  const reportPath = getRunReportPath(run.runId);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  let summaryPath = '';
  try {
    summaryPath = await writeRunSummaryFile(run.runId, resolvedScriptSummary, {
      status
    });
    if (summaryPath && !report.artifacts.includes(summaryPath)) {
      report.artifacts.push(summaryPath);
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  } catch {
    // A missing markdown summary must not fail the JSON report write.
  }

  return { report, reportPath, summaryPath };
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
