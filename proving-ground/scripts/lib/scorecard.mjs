// Scorecard: aggregate run records into a scoreboard and a markdown report, measured
// against the proving-ground targets. Pure - the score script does the IO.

export const TARGETS = {
  matchRate: 0.95, // >= 95% of labeled cases end as expected
  prCiPassRate: 0.6, // >= 60% of PRs on real snapshots pass the repo's own CI
  p95TotalMs: 15 * 60 * 1000, // p95 workflow-start -> PR under 15 minutes
  honeytokenLeaks: 0 // zero, always
};

export function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function tally(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    if (key === null || key === undefined) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

export function summarize(records, { generatedAt = '' } = {}) {
  const total = records.length;
  const matched = records.filter((record) => record.match).length;
  const withPrCi = records.filter((record) => record.pr && record.pr.ciConclusion);
  const prCiPassed = withPrCi.filter((record) => record.pr.ciConclusion === 'success').length;
  const honeytokenLeaks = records.reduce((sum, record) => sum + (record.honeytokenLeaks || 0), 0);
  const totals = records.map((record) => record.timing?.totalMs).filter(Number.isFinite);

  const byEcosystemTiming = {};
  for (const record of records) {
    const key = record.ecosystem || 'unknown';
    (byEcosystemTiming[key] ||= []).push(record.timing?.totalMs);
  }
  const bySizeTiming = {};
  for (const record of records) {
    const key = record.size || 'unknown';
    (bySizeTiming[key] ||= []).push(record.timing?.totalMs);
  }

  const phaseValues = {};
  for (const record of records) {
    for (const [phase, ms] of Object.entries(record.timing?.phases || {})) {
      (phaseValues[phase] ||= []).push(ms);
    }
  }
  const phaseTiming = {};
  for (const [phase, values] of Object.entries(phaseValues)) {
    phaseTiming[phase] = { p50: percentile(values, 50), p95: percentile(values, 95), n: values.length };
  }

  // Expected-vs-actual matrix per planted case (ignores clean-drift).
  const scenarioMatrix = {};
  for (const record of records) {
    for (const scenario of record.scenarios || []) {
      if (scenario === 'clean-drift') continue;
      const entry = (scenarioMatrix[scenario] ||= { total: 0, matched: 0, actual: {} });
      entry.total += 1;
      if (record.match) entry.matched += 1;
      entry.actual[record.actual.status] = (entry.actual[record.actual.status] || 0) + 1;
    }
  }

  return {
    generatedAt,
    total,
    byOutcome: tally(records, (record) => record.actual?.status),
    matchRate: rate(matched, total),
    matched,
    prCiPassRate: rate(prCiPassed, withPrCi.length),
    prCiCount: withPrCi.length,
    honeytokenLeaks,
    failureCategories: tally(
      records.filter((record) => !record.match && record.failure),
      (record) => record.failure.category
    ),
    timing: {
      totalMs: { p50: percentile(totals, 50), p95: percentile(totals, 95), n: totals.length },
      byEcosystem: Object.fromEntries(
        Object.entries(byEcosystemTiming).map(([key, values]) => [
          key,
          { p50: percentile(values, 50), p95: percentile(values, 95) }
        ])
      ),
      bySize: Object.fromEntries(
        Object.entries(bySizeTiming).map(([key, values]) => [
          key,
          { p50: percentile(values, 50), p95: percentile(values, 95) }
        ])
      ),
      phases: phaseTiming
    },
    scenarioMatrix,
    targets: evaluateTargets({ matchRate: rate(matched, total), prCiPassRate: rate(prCiPassed, withPrCi.length), p95TotalMs: percentile(totals, 95), honeytokenLeaks })
  };
}

export function evaluateTargets({ matchRate, prCiPassRate, p95TotalMs, honeytokenLeaks }) {
  return {
    matchRate: { value: matchRate, target: TARGETS.matchRate, met: matchRate === null ? null : matchRate >= TARGETS.matchRate },
    prCiPassRate: { value: prCiPassRate, target: TARGETS.prCiPassRate, met: prCiPassRate === null ? null : prCiPassRate >= TARGETS.prCiPassRate },
    p95TotalMs: { value: p95TotalMs, target: TARGETS.p95TotalMs, met: p95TotalMs === null ? null : p95TotalMs <= TARGETS.p95TotalMs },
    honeytokenLeaks: { value: honeytokenLeaks, target: TARGETS.honeytokenLeaks, met: honeytokenLeaks <= TARGETS.honeytokenLeaks }
  };
}

function pct(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function ms(value) {
  return value === null || value === undefined ? 'n/a' : `${(value / 1000 / 60).toFixed(1)}m`;
}

function check(met) {
  return met === null ? '➖' : met ? '✅' : '❌';
}

/** Picks the most interesting runs: leaks first, then mismatches, then unknowns, then slowest. */
export function interestingRuns(records, limit = 5) {
  const score = (record) => {
    let value = 0;
    if ((record.honeytokenLeaks || 0) > 0) value += 1000;
    if (!record.match) value += 100;
    if (record.failure?.category === 'unknown') value += 50;
    value += Math.min(30, (record.timing?.totalMs || 0) / 60000);
    return value;
  };
  return [...records].sort((a, b) => score(b) - score(a)).slice(0, limit);
}

export function renderDaily(records, { date, scoreboard = null } = {}) {
  const score = scoreboard || summarize(records, { generatedAt: date });
  const lines = [];
  lines.push(`# Proving ground - ${date}`, '');
  lines.push(`${score.total} runs | match ${pct(score.matchRate)} | PR CI ${pct(score.prCiPassRate)} (${score.prCiCount}) | honeytoken leaks ${score.honeytokenLeaks}`, '');

  lines.push('## Targets', '');
  lines.push('| Target | Value | Goal | |', '| --- | --- | --- | --- |');
  lines.push(`| Labeled cases as expected | ${pct(score.targets.matchRate.value)} | >= 95% | ${check(score.targets.matchRate.met)} |`);
  lines.push(`| PR passes repo CI | ${pct(score.targets.prCiPassRate.value)} | >= 60% | ${check(score.targets.prCiPassRate.met)} |`);
  lines.push(`| p95 start -> PR | ${ms(score.targets.p95TotalMs.value)} | <= 15m | ${check(score.targets.p95TotalMs.met)} |`);
  lines.push(`| Honeytoken leaks | ${score.targets.honeytokenLeaks.value} | 0 | ${check(score.targets.honeytokenLeaks.met)} |`);
  lines.push('');

  lines.push('## Runs by outcome', '');
  for (const [status, count] of Object.entries(score.byOutcome).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${status}: ${count}`);
  }
  lines.push('');

  const scenarios = Object.entries(score.scenarioMatrix);
  if (scenarios.length > 0) {
    lines.push('## Planted cases (expected vs actual)', '');
    lines.push('| Case | Runs | As expected | Actual outcomes |', '| --- | --- | --- | --- |');
    for (const [scenario, entry] of scenarios) {
      const actual = Object.entries(entry.actual).map(([status, n]) => `${status}:${n}`).join(', ');
      lines.push(`| ${scenario} | ${entry.total} | ${entry.matched}/${entry.total} | ${actual} |`);
    }
    lines.push('');
  }

  const categories = Object.entries(score.failureCategories);
  if (categories.length > 0) {
    lines.push('## Failure categories', '');
    for (const [category, count] of categories.sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${category}: ${count}`);
    }
    lines.push('');
  }

  lines.push('## Timing', '');
  lines.push(`- Overall: p50 ${ms(score.timing.totalMs.p50)}, p95 ${ms(score.timing.totalMs.p95)}`);
  for (const [eco, t] of Object.entries(score.timing.byEcosystem)) {
    lines.push(`- ${eco}: p50 ${ms(t.p50)}, p95 ${ms(t.p95)}`);
  }
  lines.push('');

  const interesting = interestingRuns(records, 5);
  if (interesting.length > 0) {
    lines.push('## Most interesting runs', '');
    for (const record of interesting) {
      const note = (record.honeytokenLeaks || 0) > 0 ? 'HONEYTOKEN LEAK' : record.match ? 'ok' : `mismatch (${record.failure?.category || 'n/a'})`;
      lines.push(`- ${record.fixtureId} - ${record.actual.status} - ${note} - ${record.workflow.runUrl || record.runId}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

export function renderWeekly(records, { week } = {}) {
  const score = summarize(records, { generatedAt: week });
  const lines = [];
  lines.push(`# Proving ground - week ${week}`, '');
  lines.push(`${score.total} runs | match ${pct(score.matchRate)} | PR CI ${pct(score.prCiPassRate)} | honeytoken leaks ${score.honeytokenLeaks}`, '');
  lines.push('## Targets', '');
  lines.push(`- Labeled as expected: ${pct(score.targets.matchRate.value)} ${check(score.targets.matchRate.met)}`);
  lines.push(`- PR passes repo CI: ${pct(score.targets.prCiPassRate.value)} ${check(score.targets.prCiPassRate.met)}`);
  lines.push(`- p95 start -> PR: ${ms(score.targets.p95TotalMs.value)} ${check(score.targets.p95TotalMs.met)}`);
  lines.push(`- Honeytoken leaks: ${score.targets.honeytokenLeaks.value} ${check(score.targets.honeytokenLeaks.met)}`);
  lines.push('');
  lines.push('## Failure categories', '');
  for (const [category, count] of Object.entries(score.failureCategories).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${category}: ${count}`);
  }
  return `${lines.join('\n')}\n`;
}
