/**
 * Compact after-script result capture for humans, scheduled runs, and later
 * aggregation. One row per after-script: name, pass/fail, new-vs-baseline,
 * duration, and the path to that script's full log.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { getBridgeHome } from './activityLogger.js';
import { redactSensitiveText } from './redaction.js';

export const SCRIPT_SUMMARY_SCHEMA_VERSION = 'bridge-script-summary.v1';
export const RUN_SUMMARY_FILENAME = 'bridge-summary.md';

export function getRunScriptsDirectory(runId) {
  return path.join(getBridgeHome(), 'runs', String(runId), 'scripts');
}

export function getRunSummaryPath(runId) {
  return path.join(getBridgeHome(), 'runs', String(runId), RUN_SUMMARY_FILENAME);
}

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms';
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const totalSeconds = ms / 1000;

  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

export function slugifyScriptCommand(command, fallback = 'script') {
  const slug = String(command || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return slug || fallback;
}

export function classifyAfterScriptFailure(command, comparison) {
  const newFailure = (comparison?.newFailures || []).find(
    (failure) => failure.command === command
  );

  if (newFailure) {
    return newFailure.notMeasuredOnBaseline ? 'unmeasured' : 'new';
  }

  const baselineFailure = (comparison?.baselineFailures || []).find(
    (entry) => (entry.after || entry).command === command
  );

  if (baselineFailure) {
    return 'baseline';
  }

  return null;
}

export function buildScriptSummaryRows({
  scope = 'root',
  afterResults = [],
  comparison = null,
  ran = true
} = {}) {
  return afterResults.map((result, index) => {
    const command = result.command || '';
    const passed = result.success !== false;
    const failureKind = passed ? null : classifyAfterScriptFailure(command, comparison);

    return {
      scope,
      index,
      name: command || `(script ${index + 1})`,
      command,
      result: ran ? (passed ? 'pass' : 'fail') : 'skipped',
      failureKind: ran ? failureKind : null,
      durationMs: Number.isFinite(result.durationMs) ? result.durationMs : 0,
      exitCode: result.exitCode ?? result.code ?? null,
      logPath: result.logPath || ''
    };
  });
}

export function buildScriptSummary({
  skipBeforeScripts = false,
  afterScriptsRan = true,
  earlyExit = null,
  rows = []
} = {}) {
  const failed = rows.filter((row) => row.result === 'fail').length;
  const passed = rows.filter((row) => row.result === 'pass').length;
  const newFailures = rows.filter((row) => row.failureKind === 'new').length;
  const baselineFailures = rows.filter((row) => row.failureKind === 'baseline').length;
  const unmeasuredFailures = rows.filter((row) => row.failureKind === 'unmeasured').length;

  return {
    schemaVersion: SCRIPT_SUMMARY_SCHEMA_VERSION,
    skipBeforeScripts: skipBeforeScripts === true,
    afterScriptsRan: afterScriptsRan === true,
    earlyExit: earlyExit || null,
    totals: {
      scripts: rows.length,
      passed,
      failed,
      newFailures,
      baselineFailures,
      unmeasuredFailures
    },
    scripts: rows
  };
}

function failureKindLabel(kind) {
  if (kind === 'new') {
    return 'new';
  }

  if (kind === 'baseline') {
    return 'baseline';
  }

  if (kind === 'unmeasured') {
    return 'unmeasured';
  }

  return '—';
}

function pad(value, width) {
  const text = String(value ?? '');
  if (text.length >= width) {
    return text;
  }

  return `${text}${' '.repeat(width - text.length)}`;
}

export function formatScriptSummaryTable(summary) {
  const rows = summary?.scripts || [];
  const header = ['Script', 'Result', 'Failure', 'Duration', 'Log'];

  if (rows.length === 0) {
    const reason = summary?.earlyExit
      ? `no after-scripts ran (${summary.earlyExit})`
      : summary?.afterScriptsRan === false
        ? 'no after-scripts ran'
        : 'no after-scripts configured';
    return ['After-script summary', reason].join('\n');
  }

  const body = rows.map((row) => [
    row.name,
    row.result,
    failureKindLabel(row.failureKind),
    formatDurationMs(row.durationMs),
    row.logPath || '—'
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((line) => String(line[index]).length))
  );
  const lines = [
    'After-script summary',
    header.map((cell, index) => pad(cell, widths[index])).join('  '),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...body.map((line) => line.map((cell, index) => pad(cell, widths[index])).join('  '))
  ];

  const totals = summary.totals || {};
  lines.push(
    `${totals.passed || 0} passed, ${totals.failed || 0} failed` +
      (totals.newFailures ? `, ${totals.newFailures} new` : '') +
      (totals.baselineFailures ? `, ${totals.baselineFailures} baseline` : '') +
      (totals.unmeasuredFailures ? `, ${totals.unmeasuredFailures} unmeasured` : '')
  );

  return lines.join('\n');
}

export function formatScriptSummaryMarkdown(summary, { runId = '', status = '' } = {}) {
  const rows = summary?.scripts || [];
  const lines = [
    '# Bridge after-script summary',
    '',
    `- Run: \`${runId || 'unknown'}\``,
    status ? `- Status: \`${status}\`` : '',
    `- After-scripts ran: ${summary?.afterScriptsRan ? 'yes' : 'no'}`,
    `- beforeScripts skipped: ${summary?.skipBeforeScripts ? 'yes' : 'no'}`,
    summary?.earlyExit ? `- Early exit: \`${summary.earlyExit}\`` : '',
    ''
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');

  if (rows.length === 0) {
    lines.push('No after-script rows were recorded for this run.', '');
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    '| Script | Result | Failure | Duration | Log |',
    '| --- | --- | --- | --- | --- |'
  );

  for (const row of rows) {
    const log = row.logPath ? `\`${row.logPath}\`` : '—';
    lines.push(
      `| \`${row.name.replace(/\|/g, '\\|')}\` | ${row.result} | ${failureKindLabel(row.failureKind)} | ${formatDurationMs(row.durationMs)} | ${log} |`
    );
  }

  const totals = summary.totals || {};
  lines.push(
    '',
    `${totals.passed || 0} passed / ${totals.failed || 0} failed` +
      (totals.newFailures ? ` / ${totals.newFailures} new` : '') +
      (totals.baselineFailures ? ` / ${totals.baselineFailures} already on baseline` : '') +
      (totals.unmeasuredFailures ? ` / ${totals.unmeasuredFailures} not measured on baseline` : ''),
    ''
  );

  return `${lines.join('\n')}\n`;
}

export async function writeScriptCommandLog(runId, { phase, scope = 'root', index = 0, result } = {}) {
  if (!runId || !result) {
    return '';
  }

  const directory = getRunScriptsDirectory(runId);
  await fs.mkdir(directory, { recursive: true });
  const filename = `${slugifyScriptCommand(phase, 'phase')}-${slugifyScriptCommand(scope, 'scope')}-${String(index + 1).padStart(2, '0')}-${slugifyScriptCommand(result.command)}.log`;
  const logPath = path.join(directory, filename);
  const body = [
    `command: ${result.command || ''}`,
    `scope: ${scope}`,
    `phase: ${phase || ''}`,
    `exitCode: ${result.code ?? result.exitCode ?? ''}`,
    `success: ${result.success !== false}`,
    `durationMs: ${result.durationMs || 0}`,
    '',
    '--- stdout ---',
    redactSensitiveText(result.stdout || ''),
    '',
    '--- stderr ---',
    redactSensitiveText(result.stderr || ''),
    ''
  ].join('\n');

  await fs.writeFile(logPath, body, 'utf8');
  return logPath;
}

export async function writeRunSummaryFile(runId, summary, extras = {}) {
  const summaryPath = getRunSummaryPath(runId);
  await fs.mkdir(path.dirname(summaryPath), { recursive: true });
  await fs.writeFile(summaryPath, formatScriptSummaryMarkdown(summary, { runId, ...extras }), 'utf8');
  return summaryPath;
}
