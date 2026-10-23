import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rebuildDailySummary } from './dailySummary.js';
import { notifyDailySummary } from './notifyLocal.js';
import { startPerfSampler, summarizeBatchPerformance } from './perfSampler.js';

export function getDailyWrapperPath() {
  return fileURLToPath(new URL('../../scripts/bridge-daily.sh', import.meta.url));
}

export function getBridgeCliPath() {
  return fileURLToPath(new URL('../../bin/bridge.js', import.meta.url));
}

export async function runWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(items.length);
  let next = 0;

  async function pump() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => pump());
  await Promise.all(workers);
  return results;
}

function extractRunId(output) {
  const lines = String(output || '').split(/\r?\n/);
  let found = '';

  for (const line of lines) {
    const summary = line.match(/\/runs\/([^/\s]+)\/bridge-summary\.md/);
    const report = line.match(/\/runs\/([^/\s]+)\/bridge-report/);
    if (summary) {
      found = summary[1];
    } else if (report) {
      found = report[1];
    } else {
      const captured = line.match(/Captured run-id:\s+(\S+)/);
      if (captured) {
        found = captured[1];
      }
    }
  }

  return found;
}

function spawnWrapper(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      resolve({
        code: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        success: false
      });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
        success: code === 0
      });
    });
  });
}

export function buildWrapperArgs(
  item,
  {
    wrapperPath = getDailyWrapperPath(),
    dryRun = false,
    skipBeforeScripts = true
  } = {}
) {
  const args = [wrapperPath, '--repo', item.repo];

  if (item.branch) {
    args.push('--branch', item.branch);
  }

  if (item.config) {
    args.push('--config', item.config);
  }

  if (item.workdir) {
    args.push('--workdir', item.workdir);
  }

  if (item.summaryDir) {
    args.push('--summary-dir', item.summaryDir);
  }

  if (dryRun) {
    args.push('--dry-run');
  }

  if (skipBeforeScripts) {
    args.push('--skip-before-scripts');
  } else {
    args.push('--run-before-scripts');
  }

  if (Array.isArray(item.extraArgs) && item.extraArgs.length > 0) {
    args.push('--', ...item.extraArgs);
  }

  return args;
}

export async function runScheduledRepos({
  repos = [],
  concurrency = 2,
  dryRun = false,
  skipBeforeScripts = true,
  notify = false,
  notifyCommand = '',
  cwd = process.cwd(),
  env = process.env,
  wrapperPath = getDailyWrapperPath(),
  bridgeHome = ''
} = {}) {
  const batchId = `batch-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const sampler = startPerfSampler();
  const startedAtMs = Date.now();

  const results = await runWithConcurrency(repos, concurrency, async (item) => {
    const started = Date.now();
    const args = buildWrapperArgs(item, { wrapperPath, dryRun, skipBeforeScripts });
    const spawned = await spawnWrapper(args, {
      cwd,
      env: {
        ...env,
        BRIDGE_BATCH_ID: batchId
      }
    });
    const runId = extractRunId(`${spawned.stdout}\n${spawned.stderr}`);

    return {
      repo: item.repo,
      runId,
      status: spawned.success ? 'ok' : 'failed',
      code: spawned.code,
      durationMs: Date.now() - started,
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      failureReason: spawned.success ? '' : `bridge-daily.sh exited ${spawned.code}`
    };
  });

  const batchPerf = sampler.stop();
  const reportPerfs = results.map((entry) => ({ durationMs: entry.durationMs }));
  const performance = summarizeBatchPerformance(reportPerfs, batchPerf);
  const extraRepos = results.map((entry) => ({
    repo: path.basename(String(entry.repo || '').replace(/\.git$/, '')) || 'repo',
    runId: entry.runId,
    status: entry.status,
    durationMs: entry.durationMs,
    packages: '',
    packagesUpdated: 0,
    afterScripts: '',
    pr: '—',
    failureReason: entry.failureReason
  }));

  const daily = await rebuildDailySummary({
    bridgeHome: bridgeHome || undefined,
    batch: {
      id: batchId,
      startedAt: new Date(startedAtMs).toISOString(),
      performance,
      concurrency: Math.max(1, Number(concurrency) || 1),
      dryRun,
      skipBeforeScripts
    },
    extraRepos: extraRepos.filter((entry) => !entry.runId)
  });

  let notification = { sent: false, reason: 'not_requested' };
  if (notify || env.BRIDGE_NOTIFY || env.BRIDGE_NOTIFY_COMMAND) {
    notification = await notifyDailySummary({
      summaryText: daily.text,
      summaryPath: daily.latestPath,
      enabled: notify || undefined,
      notifyCommand,
      bridgeHome: bridgeHome || undefined,
      env
    });
  }

  return {
    batchId,
    results,
    performance,
    daily,
    notification,
    ok: results.every((entry) => entry.status === 'ok')
  };
}
