// Builds one run record (schema/run-record.schema.json) from a Bridge report, the PR
// state, and the workflow run. Pure: the collector does the IO and hands the pieces in.

import { classifyRun } from './classify.mjs';
import { managerProfile } from './fleet.mjs';

const BLOCK_GATES = new Set([
  'policy_block',
  'audit_block',
  'bundle_block',
  'validation_block',
  'cooldown_block'
]);

export function deriveActual(report) {
  if (!report) {
    return { status: 'no_report', gate: null, message: null };
  }

  const earlyExitCode = report.outcome?.earlyExit?.code || '';
  const gate = BLOCK_GATES.has(earlyExitCode) ? earlyExitCode : null;
  const publishStatus = report.publish?.status || '';
  const runStatus = report.run?.status || '';
  const message =
    report.outcome?.failure?.message || report.publish?.message || null;

  let status;
  if (runStatus === 'cancelled') {
    status = 'cancelled';
  } else if (publishStatus === 'created') {
    status = 'pr_opened';
  } else if (publishStatus === 'updated') {
    status = 'pr_updated';
  } else if (publishStatus === 'reused') {
    status = 'pr_unchanged';
  } else if (publishStatus === 'blocked') {
    status = 'blocked';
  } else if (publishStatus === 'up_to_date' || runStatus === 'up_to_date') {
    status = 'up_to_date';
  } else if (gate) {
    status = 'blocked';
  } else if (runStatus === 'pushed') {
    status = 'pr_opened';
  } else {
    status = 'failed';
  }

  return { status, gate, message };
}

/** Does the PR / report carry a version an expectation forbids (mustNotContain)? */
export function containsForbidden(report, prBody, mustNotContain = []) {
  if (!mustNotContain || mustNotContain.length === 0) {
    return false;
  }

  const deltas = report?.outcome?.dependencyDeltas || [];
  const deltaStrings = deltas.map((delta) => `${delta.name}@${delta.to}`);
  const haystack = [...deltaStrings, String(prBody || '')].join('\n');
  return mustNotContain.some((needle) => haystack.includes(needle));
}

export function matchExpected(expected, actual, { honeytokenLeaks = 0, failureCategory = null, forbiddenHit = false } = {}) {
  const statusOk = (expected.status || []).includes(actual.status);
  // A gate is only required when Bridge actually blocked; a clean PR that simply
  // avoided the bad version (native cooldown) is fine as long as mustNotContain holds.
  const gateOk = actual.status !== 'blocked' || !expected.gate || actual.gate === expected.gate;
  const honeyOk = expected.honeytokenLeaks === undefined || honeytokenLeaks === expected.honeytokenLeaks;
  const categoryOk = !expected.failureCategory || failureCategory === expected.failureCategory;
  return Boolean(statusOk && gateOk && honeyOk && categoryOk && !forbiddenHit);
}

function phaseTimings(report) {
  const phases = {};
  for (const phase of report?.phases || []) {
    if (phase?.phase && Number.isFinite(phase.durationMs)) {
      phases[phase.phase] = phase.durationMs;
    }
  }
  return phases;
}

/**
 * @param {object} args
 * @param {object} args.fixture      Catalog entry.
 * @param {object} args.expected     From expectedForFixture().
 * @param {object|null} args.report  Bridge report (final preferred).
 * @param {object} [args.pr]         { number, url, ciConclusion, state, mergedAt, body }.
 * @param {object} args.workflow     { runUrl, conclusion, artifacts, timing }.
 * @param {string} args.experimentId
 * @param {number} [args.honeytokenLeaks]
 * @param {string} [args.collectedAt] ISO.
 * @param {string} [args.rawBundle]
 * @param {string} [args.logsText]
 */
export function buildRunRecord({
  fixture,
  expected,
  report = null,
  pr = null,
  workflow,
  experimentId,
  honeytokenLeaks = 0,
  collectedAt,
  rawBundle = '',
  logsText = ''
}) {
  const profile = managerProfile(fixture.manager);
  const actual = deriveActual(report);
  const forbiddenHit = containsForbidden(report, pr?.body, expected.mustNotContain);
  const failure = classifyRun({ report, logsText, status: actual.status, honeytokenLeaks });
  const match = matchExpected(expected, actual, {
    honeytokenLeaks,
    failureCategory: failure?.category || null,
    forbiddenHit
  });

  const summary = report?.outcome?.dependencySummary || null;
  const runId = report?.run?.id || `wf-${workflow?.runId || 'unknown'}`;

  const record = {
    recordVersion: 1,
    runId,
    experimentId,
    fixtureId: fixture.id,
    tier: fixture.tier,
    ecosystem: fixture.ecosystem,
    manager: profile.packageManager,
    size: fixture.size,
    mode: fixture.mode,
    scenarios: fixture.scenarios || [],
    bridge: {
      ref: report?.experiment ? undefined : undefined,
      sha: report?.git?.headSha || '',
      version: report?.run?.bridgeVersion || ''
    },
    asOf: report?.run?.asOf || null,
    collectedAt,
    expected,
    actual,
    match,
    failure: match ? null : failure,
    changes: summary
      ? { direct: summary.directChanged || 0, transitive: summary.transitiveChanged || 0, byBump: summary.byBump || {} }
      : { direct: 0, transitive: 0, byBump: {} },
    cooldown: report?.outcome?.cooldown || null,
    audit: report?.outcome?.audits || null,
    checks: report?.outcome?.scriptSummary || null,
    honeytokenLeaks,
    pr: pr
      ? {
          number: pr.number,
          url: pr.url,
          ciConclusion: pr.ciConclusion ?? null,
          state: pr.state,
          mergedAt: pr.mergedAt ?? null
        }
      : null,
    timing: {
      ...(workflow?.timing || {}),
      phases: phaseTimings(report)
    },
    workflow: {
      runUrl: workflow?.runUrl || '',
      conclusion: workflow?.conclusion || '',
      artifacts: workflow?.artifacts || []
    },
    ...(rawBundle ? { rawBundle } : {})
  };

  // Keep bridge.ref only when known (dispatch records it on the workflow).
  record.bridge.ref = workflow?.bridgeRef || report?.experiment?.bridgeRef || '';
  return record;
}
