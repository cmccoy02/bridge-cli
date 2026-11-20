// Notifications. Connor should hear about surprises, not routine. All of these are
// no-ops when SLACK_WEBHOOK_URL is absent. The scripts compute the numbers; this only
// decides what is worth saying and posts it.

import { diffScoreboards } from './scorecard.mjs';

export async function postSlack(webhook, text, { fetchImpl = globalThis.fetch } = {}) {
  if (!webhook || !text) {
    return { status: 'skipped' };
  }
  try {
    const response = await fetchImpl(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    return { status: response.ok ? 'sent' : 'failed', code: response.status };
  } catch (error) {
    return { status: 'failed', message: error?.message || String(error) };
  }
}

function pct(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/** A daily alert, but only when something is unexpected. Returns null for a quiet day. */
export function buildDailyAlert({ scoreboard, previous = null, dayRecords = [], date = '', incomplete = false } = {}) {
  const leaks = dayRecords.filter((record) => (record.honeytokenLeaks || 0) > 0);
  const mismatches = dayRecords.filter((record) => record.match === false);
  const diff = previous ? diffScoreboards(scoreboard, previous) : { newCategories: [], grownCategories: [] };

  const surprising =
    leaks.length > 0 ||
    mismatches.length > 0 ||
    (diff.newCategories || []).length > 0 ||
    incomplete;

  if (!surprising) {
    return null;
  }

  const lines = [`:warning: Proving ground ${date}: ${dayRecords.length} runs, match ${pct(scoreboard.matchRate)}.`];

  if (leaks.length > 0) {
    lines.push(`:rotating_light: ${leaks.length} HONEYTOKEN LEAK(S): ${leaks.map((record) => record.fixtureId).join(', ')}`);
  }
  if (incomplete) {
    lines.push('Cycle did not complete (no runs recorded for the expected fixtures).');
  }
  if (mismatches.length > 0) {
    const byFixture = mismatches.map((record) => `${record.fixtureId} (${record.actual?.status}${record.failure ? `/${record.failure.category}` : ''})`);
    lines.push(`${mismatches.length} mismatch(es): ${byFixture.slice(0, 10).join(', ')}`);
  }
  if ((diff.newCategories || []).length > 0) {
    lines.push(`New failure categories: ${diff.newCategories.join(', ')}`);
  }
  if ((diff.grownCategories || []).length > 0) {
    lines.push(`Grown failure categories: ${diff.grownCategories.join(', ')}`);
  }

  return { text: lines.join('\n') };
}

/** An immediate alert for honeytoken leaks found during collection. */
export function buildLeakAlert(leakRecords = []) {
  if (!leakRecords || leakRecords.length === 0) {
    return null;
  }
  const lines = [`:rotating_light: Proving ground: ${leakRecords.length} honeytoken leak(s) just collected.`];
  for (const record of leakRecords.slice(0, 10)) {
    lines.push(`- ${record.fixtureId} ${record.runId}: ${record.honeytokenLeaks} sighting(s) - ${record.workflow?.runUrl || ''}`);
  }
  return { text: lines.join('\n') };
}

export function buildWeeklyDigest(scoreboard, { week = '' } = {}) {
  const targets = scoreboard.targets || {};
  const mark = (met) => (met === null || met === undefined ? '➖' : met ? '✅' : '❌');
  const lines = [
    `:bar_chart: Proving ground weekly digest ${week}`,
    `Runs: ${scoreboard.total} | match ${pct(scoreboard.matchRate)} ${mark(targets.matchRate?.met)} | PR CI ${pct(scoreboard.prCiPassRate)} ${mark(targets.prCiPassRate?.met)} | leaks ${scoreboard.honeytokenLeaks} ${mark(targets.honeytokenLeaks?.met)}`
  ];
  const categories = Object.entries(scoreboard.failureCategories || {});
  if (categories.length > 0) {
    lines.push(`Failure categories: ${categories.map(([category, count]) => `${category}:${count}`).join(', ')}`);
  }
  return { text: lines.join('\n') };
}
