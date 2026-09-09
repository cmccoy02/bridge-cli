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

function defaultBody({ branchName, baseBranch, dependencySummary }) {
  const direct = Number(dependencySummary?.directChanged) || 0;
  const transitive = Number(dependencySummary?.transitiveChanged) || 0;

  return [
    '## Bridge dependency maintenance',
    '',
    `- Base branch: \`${baseBranch}\``,
    `- Candidate branch: \`${branchName}\``,
    `- Dependency changes: ${direct} direct, ${transitive} transitive`,
    '',
    'Bridge ran the repository-configured validation checks before and after the update. Please review the diff and CI before merging.'
  ].join('\n');
}

export async function createPullRequest({
  cwd,
  branchName,
  baseBranch,
  repoUrl,
  dependencySummary,
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
  const body = config.body || defaultBody({ branchName, baseBranch, dependencySummary });
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
