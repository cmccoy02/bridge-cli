import { formatBytes } from './bundleAnalysis.js';
import { commandExists, runCommand } from './executor.js';
import { redactSensitiveText } from './redaction.js';
import { formatValidationPrLine } from './scriptDiff.js';

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `"'"'`)}'`;
}

function normalizeOptions(options = {}) {
  if (options === false) {
    return { enabled: false, draft: false, title: '', body: '' };
  }

  return {
    enabled: options?.enabled !== false,
    draft: options?.draft === true,
    title: typeof options?.title === 'string' ? options.title.trim() : '',
    body: typeof options?.body === 'string' ? options.body.trim() : ''
  };
}

function findPullRequestUrl(output) {
  const match = String(output || '').match(/https:\/\/[^\s]+\/pull\/\d+/);
  return match?.[0] || '';
}

export function getGitHubRepository(remoteUrl) {
  const value = String(remoteUrl || '').trim();

  if (!value) {
    return '';
  }

  const match = value.match(
    /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com(?::|\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i
  );

  if (!match) {
    return '';
  }

  return `${match[1]}/${match[2]}`;
}

function formatSeverityDelta(delta) {
  if (!delta) {
    return '';
  }

  const parts = [];
  const severities = ['critical', 'high', 'moderate', 'low'];

  for (const severity of severities) {
    const change = delta[severity];
    if (change !== 0) {
      const sign = change > 0 ? '+' : '';
      parts.push(`${severity}: ${sign}${change}`);
    }
  }

  return parts.length > 0 ? parts.join(', ') : 'no change';
}

function formatBumpSummary(byBump) {
  if (!byBump) {
    return '';
  }

  const parts = [];
  if (byBump.patch > 0) parts.push(`${byBump.patch} patch`);
  if (byBump.minor > 0) parts.push(`${byBump.minor} minor`);
  if (byBump.major > 0) parts.push(`${byBump.major} major`);
  if (byBump.other > 0) parts.push(`${byBump.other} other`);

  return parts.length > 0 ? parts.join(', ') : 'none';
}

function formatPackageTable(deltas = []) {
  const direct = (Array.isArray(deltas) ? deltas : [])
    .filter((delta) => delta?.kind === 'direct' && delta.from !== delta.to)
    .slice(0, 40);

  if (direct.length === 0) {
    return [];
  }

  const lines = [
    '',
    '### Package changes',
    '',
    '| Package | From | To | Type |',
    '| --- | --- | --- | --- |'
  ];

  for (const delta of direct) {
    lines.push(
      `| \`${delta.name}\` | ${delta.from ?? '—'} | ${delta.to ?? '—'} | ${delta.bump || 'other'} |`
    );
  }

  const omitted = deltas.filter((delta) => delta?.kind === 'direct').length - direct.length;

  if (omitted > 0) {
    lines.push('', `_Showing 40 of ${direct.length + omitted} direct package changes._`);
  }

  return lines;
}

function formatBundleSection(bundleResults = []) {
  const entries = (Array.isArray(bundleResults) ? bundleResults : []).filter(
    (entry) => entry?.comparison
  );

  if (entries.length === 0) {
    return [];
  }

  const lines = ['', '### Bundle size'];

  for (const entry of entries) {
    const comparison = entry.comparison;
    const sign = comparison.deltaBytes > 0 ? '+' : '';
    const scopeLabel = entry.label || 'root';
    lines.push(
      `- **${scopeLabel} (${comparison.metric}):** ${formatBytes(comparison.beforeBytes)} → ${formatBytes(comparison.afterBytes)} (${sign}${formatBytes(comparison.deltaBytes)}, ${sign}${Number(comparison.deltaPercent || 0).toFixed(2)}%)`
    );
  }

  return lines;
}

export function buildPullRequestBody({
  branchName,
  baseBranch,
  dependencySummary,
  dependencyDeltas = [],
  auditResults,
  validationResults,
  bundleResults = [],
  runReportPath,
  bridgeVersion = ''
}) {
  const direct = Number(dependencySummary?.directChanged) || 0;
  const transitive = Number(dependencySummary?.transitiveChanged) || 0;
  const byBump = dependencySummary?.byBump;

  const lines = [
    '## Bridge dependency maintenance',
    '',
    '### Summary',
    '',
    `- **Base branch:** \`${baseBranch}\``,
    `- **Candidate branch:** \`${branchName}\``,
    `- **Dependency changes:** ${direct} direct, ${transitive} transitive`
  ];

  if (byBump) {
    lines.push(`- **Update types:** ${formatBumpSummary(byBump)}`);
  }

  if (bridgeVersion) {
    lines.push(`- **Bridge:** ${bridgeVersion}`);
  }

  lines.push(...formatPackageTable(dependencyDeltas));
  lines.push(...formatBundleSection(bundleResults));

  if (Array.isArray(auditResults) && auditResults.length > 0) {
    lines.push('', '### Security audit');

    for (const audit of auditResults) {
      if (!audit?.comparison?.comparable) {
        continue;
      }

      const { before, after, comparison } = audit;
      const scopeLabel = audit.label || 'root';
      const totalBefore = before?.counts?.total ?? '?';
      const totalAfter = after?.counts?.total ?? '?';
      const severityDelta = formatSeverityDelta(comparison.delta);

      lines.push(`- **${scopeLabel}:** ${totalBefore} → ${totalAfter} vulnerabilities (${severityDelta})`);

      if (comparison.blocked) {
        lines.push(`  - ⚠️ ${comparison.blockReason}`);
      }
    }
  }

  if (Array.isArray(validationResults) && validationResults.length > 0) {
    const hasScriptInfo = validationResults.some((v) => v?.scriptDiff?.diff);

    if (hasScriptInfo) {
      lines.push('', '### Validation scripts');

      for (const validation of validationResults) {
        if (!validation?.scriptDiff?.diff) {
          continue;
        }

        const { comparison } = validation;
        const scopeLabel = validation.label || 'root';

        lines.push(formatValidationPrLine(comparison, scopeLabel));

        if (comparison?.resolvedCount > 0) {
          lines.push(
            `  - ${comparison.resolvedCount} pre-existing baseline failure(s) now pass`
          );
        }
      }
    }
  }

  lines.push(
    '',
    '### Review',
    '',
    'Bridge ran the repository-configured validation checks before and after the update. Please review the diff and CI before merging.'
  );

  if (runReportPath) {
    lines.push('', `> Report: \`${runReportPath}\``);
  }

  return lines.join('\n');
}

export function normalizePullRequestDiff(diff) {
  return String(diff || '')
    .replace(/\r\n/g, '\n')
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gim, '')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

export function filesFromDiff(diff) {
  const files = [];

  for (const match of String(diff || '').matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    files.push(match[2]);
  }

  return [...new Set(files)].sort();
}

function sameFileSet(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((file, index) => file === right[index]);
}

function isBridgePullRequest(entry, branchPrefix) {
  const title = String(entry?.title || '');
  const head = String(entry?.headRefName || '');
  const prefix = String(branchPrefix || 'bridge/patch');

  return title.startsWith('bridge:') || head === prefix || head.startsWith(`${prefix}-`);
}

export async function findReusableBridgePullRequest({
  cwd,
  repoUrl,
  baseBranch,
  branchPrefix = 'bridge/patch',
  stagedDiff = '',
  commandExistsFn = commandExists,
  runCommandFn = runCommand
} = {}) {
  if (!stagedDiff || !(await commandExistsFn('gh'))) {
    return null;
  }

  const repository = getGitHubRepository(repoUrl);
  const listCommand = [
    'gh pr list',
    repository ? `--repo ${shellQuote(repository)}` : '',
    '--state open',
    '--limit 50',
    '--json number,url,title,headRefName,baseRefName'
  ]
    .filter(Boolean)
    .join(' ');
  const listed = await runCommandFn(listCommand, {
    cwd,
    allowFailure: true,
    quiet: true
  });

  if (!listed.success) {
    return null;
  }

  let pullRequests = [];

  try {
    pullRequests = JSON.parse(listed.stdout || '[]');
  } catch {
    return null;
  }

  const candidates = (Array.isArray(pullRequests) ? pullRequests : []).filter(
    (entry) =>
      isBridgePullRequest(entry, branchPrefix) &&
      (!baseBranch || !entry.baseRefName || entry.baseRefName === baseBranch)
  );

  if (candidates.length === 0) {
    return null;
  }

  const localFiles = filesFromDiff(stagedDiff);
  const localNormalized = normalizePullRequestDiff(stagedDiff);

  for (const candidate of candidates) {
    const diffCommand = [
      'gh pr diff',
      String(candidate.number),
      repository ? `--repo ${shellQuote(repository)}` : ''
    ]
      .filter(Boolean)
      .join(' ');
    const remote = await runCommandFn(diffCommand, {
      cwd,
      allowFailure: true,
      quiet: true
    });

    if (!remote.success) {
      continue;
    }

    const remoteDiff = remote.stdout || '';
    const remoteNormalized = normalizePullRequestDiff(remoteDiff);
    const remoteFiles = filesFromDiff(remoteDiff);

    if (localNormalized && remoteNormalized && localNormalized === remoteNormalized) {
      return {
        ...candidate,
        identical: true,
        sameFiles: true
      };
    }

    if (localFiles.length > 0 && sameFileSet(localFiles, remoteFiles)) {
      return {
        ...candidate,
        identical: false,
        sameFiles: true
      };
    }
  }

  return null;
}

export async function updatePullRequest({
  cwd,
  number,
  repoUrl,
  body = '',
  title = '',
  commandExistsFn = commandExists,
  runCommandFn = runCommand
} = {}) {
  if (!number || !(await commandExistsFn('gh'))) {
    return { status: 'unavailable', url: '', message: 'GitHub CLI is not available to update the pull request.' };
  }

  const repository = getGitHubRepository(repoUrl);
  const command = [
    'gh pr edit',
    String(number),
    repository ? `--repo ${shellQuote(repository)}` : '',
    title ? `--title ${shellQuote(title)}` : '',
    body ? `--body ${shellQuote(body)}` : ''
  ]
    .filter(Boolean)
    .join(' ');
  const updated = await runCommandFn(command, {
    cwd,
    allowFailure: true,
    quiet: true
  });

  if (!updated.success) {
    return {
      status: 'failed',
      url: '',
      message: `GitHub CLI could not update pull request #${number}: ${redactSensitiveText(`${updated.stdout || ''}\n${updated.stderr || ''}`.trim()) || 'unknown error'}`
    };
  }

  return {
    status: 'updated',
    url: '',
    message: `Updated pull request #${number}`
  };
}

export async function createPullRequest({
  cwd,
  branchName,
  baseBranch,
  repoUrl,
  dependencySummary,
  dependencyDeltas = [],
  auditResults = [],
  validationResults = [],
  bundleResults = [],
  runReportPath = '',
  bridgeVersion = '',
  options,
  commandExistsFn = commandExists,
  runCommandFn = runCommand
} = {}) {
  const config = normalizeOptions(options);

  if (!config.enabled) {
    return { status: 'disabled', url: '', message: 'Pull request creation is disabled.' };
  }

  if (!(await commandExistsFn('gh'))) {
    return {
      status: 'unavailable',
      url: '',
      message: 'GitHub CLI is not installed; branch was pushed but no pull request was created.'
    };
  }

  const auth = await runCommandFn('gh auth status', {
    cwd,
    allowFailure: true,
    quiet: true
  });

  if (!auth.success) {
    return {
      status: 'unauthenticated',
      url: '',
      message:
        'GitHub CLI is not authenticated; branch was pushed but no pull request was created. Bridge will reuse an existing gh session or GH_TOKEN/GITHUB_TOKEN when available.'
    };
  }

  const title = config.title || 'bridge: update dependencies (non-breaking)';
  const body = config.body || buildPullRequestBody({
    branchName,
    baseBranch,
    dependencySummary,
    dependencyDeltas,
    auditResults,
    validationResults,
    bundleResults,
    runReportPath,
    bridgeVersion
  });
  const repository = getGitHubRepository(repoUrl);
  const command = [
    'gh pr create',
    repository ? `--repo ${shellQuote(repository)}` : '',
    `--base ${shellQuote(baseBranch)}`,
    `--head ${shellQuote(branchName)}`,
    `--title ${shellQuote(title)}`,
    `--body ${shellQuote(body)}`,
    config.draft ? '--draft' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const created = await runCommandFn(command, {
    cwd,
    allowFailure: true,
    quiet: true
  });
  const output = `${created.stdout || ''}\n${created.stderr || ''}`.trim();

  if (!created.success) {
    const existingCommand = [
      'gh pr view',
      repository ? `--repo ${shellQuote(repository)}` : '',
      `--head ${shellQuote(branchName)}`,
      '--json url',
      '--jq .url'
    ]
      .filter(Boolean)
      .join(' ');
    const existing = await runCommandFn(existingCommand, {
      cwd,
      allowFailure: true,
      quiet: true
    });
    const existingUrl = findPullRequestUrl(existing.stdout || existing.stderr);

    if (existing.success && existingUrl) {
      return {
        status: 'existing',
        url: existingUrl,
        message: `Pull request already open: ${existingUrl}`
      };
    }

    return {
      status: 'failed',
      url: '',
      message: `GitHub CLI could not create a pull request: ${redactSensitiveText(output) || 'unknown error'}`
    };
  }

  const url = findPullRequestUrl(output);

  return {
    status: 'created',
    url,
    message: url ? `Pull request created: ${url}` : 'Pull request created.'
  };
}
