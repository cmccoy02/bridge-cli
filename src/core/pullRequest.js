import { commandExists, runCommand } from './executor.js';
import { redactSensitiveText } from './redaction.js';

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

function defaultBody({
  branchName,
  baseBranch,
  dependencySummary,
  auditResults,
  validationResults,
  runReportPath
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

        const { scriptDiff, comparison } = validation;
        const scopeLabel = validation.label || 'root';

        if (comparison?.hasNewFailures) {
          lines.push(`- **${scopeLabel}:** ❌ ${comparison.newFailureCount} new failure(s)`);
        } else if (comparison?.hasBaselineNoise) {
          lines.push(`- **${scopeLabel}:** ⚠️ ${comparison.baselineFailureCount} baseline failure(s) (unchanged)`);
        } else {
          lines.push(`- **${scopeLabel}:** ✅ all scripts passed`);
        }

        if (comparison?.resolvedCount > 0) {
          lines.push(`  - ${comparison.resolvedCount} previously failing script(s) now pass`);
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

export async function createPullRequest({
  cwd,
  branchName,
  baseBranch,
  repoUrl,
  dependencySummary,
  auditResults = [],
  validationResults = [],
  runReportPath = '',
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
  const body = config.body || defaultBody({
    branchName,
    baseBranch,
    dependencySummary,
    auditResults,
    validationResults,
    runReportPath
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
