import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from './executor.js';
import { resolvePathInside } from './pathSafety.js';

const METRIC_FIELDS = {
  rendered: 'renderedLength',
  gzip: 'gzipLength',
  brotli: 'brotliLength'
};

function safeArtifactSegment(value) {
  return String(value || 'root')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
}

export function parseVisualizerHtml(content) {
  const text = String(content || '');
  const match = text.match(/const data = (\{[\s\S]*?\});\s*\n\s*const run/);

  if (!match) {
    throw new Error('Could not find rollup-plugin-visualizer data in the HTML report.');
  }

  const data = JSON.parse(match[1]);
  const nodeParts = Object.values(data?.nodeParts || {});
  const totals = {
    rendered: 0,
    gzip: 0,
    brotli: 0
  };

  for (const part of nodeParts) {
    totals.rendered += Number(part?.renderedLength) || 0;
    totals.gzip += Number(part?.gzipLength) || 0;
    totals.brotli += Number(part?.brotliLength) || 0;
  }

  return {
    version: data?.version ?? null,
    modules: nodeParts.length,
    totals,
    options: data?.options || {},
    environment: data?.env || {}
  };
}

export function compareBundleAnalyses(before, after, options = {}) {
  const metric = Object.prototype.hasOwnProperty.call(METRIC_FIELDS, options.metric)
    ? options.metric
    : 'brotli';
  const beforeBytes = Number(before?.totals?.[metric]) || 0;
  const afterBytes = Number(after?.totals?.[metric]) || 0;
  const deltaBytes = afterBytes - beforeBytes;
  const deltaPercent = beforeBytes > 0 ? (deltaBytes / beforeBytes) * 100 : 0;
  const maxIncreasePercent =
    typeof options.maxIncreasePercent === 'number'
      ? options.maxIncreasePercent
      : Number.NaN;
  const maxIncreaseBytes =
    typeof options.maxIncreaseBytes === 'number'
      ? options.maxIncreaseBytes
      : Number.NaN;
  const percentExceeded =
    Number.isFinite(maxIncreasePercent) &&
    maxIncreasePercent >= 0 &&
    deltaPercent > maxIncreasePercent;
  const bytesExceeded =
    Number.isFinite(maxIncreaseBytes) &&
    maxIncreaseBytes >= 0 &&
    deltaBytes > maxIncreaseBytes;

  return {
    metric,
    beforeBytes,
    afterBytes,
    deltaBytes,
    deltaPercent,
    regressed: deltaBytes > 0,
    thresholdExceeded: percentExceeded || bytesExceeded,
    percentExceeded,
    bytesExceeded
  };
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  const absolute = Math.abs(bytes);

  if (absolute < 1024) {
    return `${bytes} B`;
  }

  if (absolute < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export async function runBundleAnalysis({
  cwd,
  config,
  runId,
  scopeLabel,
  stage,
  quiet = true
}) {
  if (!config?.command || !config?.reportPath) {
    return {
      supported: false,
      stage,
      reportPath: '',
      artifactPath: '',
      analysis: null
    };
  }

  const reportPath = resolvePathInside(cwd, config.reportPath);
  let originalReport = null;

  try {
    originalReport = await fs.readFile(reportPath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await fs.rm(reportPath, { force: true });
    await runCommand(config.command, { cwd, quiet });

    const content = await fs.readFile(reportPath, 'utf8');
    const analysis = parseVisualizerHtml(content);
    const artifactDir = path.join(
      os.homedir(),
      '.bridge',
      'artifacts',
      safeArtifactSegment(runId),
      safeArtifactSegment(scopeLabel)
    );
    const extension = path.extname(reportPath) || '.html';
    const artifactPath = path.join(artifactDir, `analyze-${stage}${extension}`);

    await fs.mkdir(artifactDir, { recursive: true });
    await fs.copyFile(reportPath, artifactPath);

    return {
      supported: true,
      stage,
      reportPath,
      artifactPath,
      analysis
    };
  } finally {
    if (originalReport) {
      await fs.writeFile(reportPath, originalReport);
    } else {
      await fs.rm(reportPath, { force: true });
    }
  }
}
