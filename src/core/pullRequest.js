import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { formatBytes } from './bundleAnalysis.js';
import { commandExists, runCommand } from './executor.js';
import { redactSensitiveText } from './redaction.js';
import { formatValidationPrLine } from './scriptDiff.js';

const BRIDGE_PR_MARKER_RE = /<!--\s*bridge-meta:([\s\S]*?)-->/;
const BRIDGE_COMMIT_SUBJECT_PREFIX = 'bridge: update dependencies';
export const BRIDGE_COMMIT_SUBJECT = 'bridge: update dependencies (non-breaking)';
export const BRIDGE_COMMIT_TRAILER = 'Bridge-Commit: true';
const BRIDGE_COMMIT_TRAILER_RE = /(?:^|\n)\s*Bridge-Commit:\s*true\s*(?:\n|$)/i;
const PR_LIST_JSON_FIELDS = 'number,url,title,headRefName,baseRefName,body,author';
const PR_LIST_LIMIT = 30;

export function buildBridgeCommitMessage(subject = BRIDGE_COMMIT_SUBJECT) {
  return `${String(subject || BRIDGE_COMMIT_SUBJECT).trim()}\n\n${BRIDGE_COMMIT_TRAILER}\n`;
}

export class PullRequestLookupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PullRequestLookupError';
  }
}

function formatGhOutput(result) {
  return redactSensitiveText(`${result?.stdout || ''}\n${result?.stderr || ''}`.trim());
}

function throwPullRequestLookupError(detail) {
  throw new PullRequestLookupError(
    `${detail} Refusing to open a new pull request that might duplicate an existing Bridge PR.`
  );
}

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

export function buildBridgePrMarker(meta = {}) {
  return `<!-- bridge-meta:${JSON.stringify(meta)} -->`;
}

export function parseBridgePrMarker(body) {
  const match = String(body || '').match(BRIDGE_PR_MARKER_RE);

  if (!match) {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function normalizeAuthorToken(value) {
  return String(value || '').trim().toLowerCase();
}

function collectCommitAuthors(commit) {
  const authors = [];

  if (Array.isArray(commit?.authors)) {
    authors.push(...commit.authors);
  }

  if (commit?.author && typeof commit.author === 'object') {
    authors.push(commit.author);
  }

  if (commit?.authorName || commit?.authorEmail || commit?.authorLogin) {
    authors.push({
      name: commit.authorName,
      email: commit.authorEmail,
      login: commit.authorLogin
    });
  }

  return authors
    .map((author) => ({
      name: normalizeAuthorToken(author?.name),
      email: normalizeAuthorToken(author?.email),
      login: normalizeAuthorToken(author?.login)
    }))
    .filter((author) => author.name || author.email || author.login);
}

function commitSubject(commit) {
  return String(commit?.messageHeadline || commit?.subject || commit?.message || '')
    .trim()
    .split('\n')[0];
}

export function isBridgeCommitSubject(subject) {
  return String(subject || '').trim().startsWith(BRIDGE_COMMIT_SUBJECT_PREFIX);
}

export function hasBridgeCommitMarker(commit) {
  const trailer = String(commit?.bridgeTrailer || '').trim().toLowerCase();

  if (trailer === 'true' || trailer === BRIDGE_COMMIT_TRAILER.toLowerCase()) {
    return true;
  }

  const body = String(
    commit?.messageBody || commit?.body || commit?.message || commit?.messageHeadline || ''
  );

  return BRIDGE_COMMIT_TRAILER_RE.test(body);
}

export function isBridgeAuthor(author, expectedAuthors = []) {
  const candidates = collectCommitAuthors({ authors: [author] });

  if (candidates.length === 0) {
    return false;
  }

  return candidates.some((candidate) => {
    if (candidate.name === 'bridge' || candidate.login === 'bridge' || candidate.login === 'bridge-cli') {
      return true;
    }

    if (candidate.email.startsWith('bridge@')) {
      return true;
    }

    // Matching the PR author (or any other human) is not enough. A reviewer
    // or PR author can reuse Bridge's subject without being Bridge itself.
    void expectedAuthors;
    return false;
  });
}

export function isBridgeAuthoredCommit(commit, { expectedAuthors = [] } = {}) {
  if (hasBridgeCommitMarker(commit)) {
    return true;
  }

  if (!isBridgeCommitSubject(commitSubject(commit))) {
    return false;
  }

  const authors = collectCommitAuthors(commit);

  if (authors.length === 0) {
    return true;
  }

  return authors.some((author) => isBridgeAuthor(author, expectedAuthors));
}

export function getForeignPullRequestCommits(commits = [], { expectedAuthors = [] } = {}) {
  const list = Array.isArray(commits) ? commits : [];
  const hasAuthorMetadata = list.some((commit) => collectCommitAuthors(commit).length > 0);

  if (!hasAuthorMetadata) {
    return list.filter((commit) => !isBridgeCommitSubject(commitSubject(commit)));
  }

  return list.filter((commit) => !isBridgeAuthoredCommit(commit, { expectedAuthors }));
}

export function makePullRequestScopeKey({
  configSha256 = '',
  requestedScope = 'all',
  updateCommands = []
} = {}) {
  const commands = (Array.isArray(updateCommands) ? updateCommands : [])
    .map((command) => String(command || '').trim())
    .filter(Boolean);

  return [String(configSha256 || ''), String(requestedScope || 'all'), commands.join('\n')].join('|');
}

export function getStablePullRequestIdentity(scopeKey = '') {
  const parts = String(scopeKey || '').split('|');

  if (parts.length >= 3) {
    return parts.slice(0, 3).join('|');
  }

  return String(scopeKey || '');
}

export function decidePullRequestReuse({
  identical = false,
  localScopeKey = '',
  remoteMarker = null,
  foreignCommits = []
} = {}) {
  if (identical) {
    return { action: 'reuse_identical', reason: '' };
  }

  if (Array.isArray(foreignCommits) && foreignCommits.length > 0) {
    return {
      action: 'open_new',
      reason:
        'An open Bridge pull request contains commits Bridge did not author. Opening a new PR instead of replacing it.'
    };
  }

  const remoteScopeKey = remoteMarker?.scopeKey || '';

  if (
    localScopeKey &&
    remoteScopeKey &&
    getStablePullRequestIdentity(localScopeKey) !== getStablePullRequestIdentity(remoteScopeKey)
  ) {
    return {
      action: 'open_new',
      reason:
        'An open Bridge pull request covers a different update scope. Opening a new PR instead of replacing it.'
    };
  }

  return { action: 'update', reason: '' };
}

// Both shapes keep status 'existing'; `reused` is what tells classifyPrAction
// (runSignal.js) that nothing was pushed, versus new content on the open PR.
export function reusedPullRequestResult(url) {
  return {
    status: 'existing',
    reused: true,
    url,
    message: `Reusing open Bridge pull request with identical changes: ${url}`
  };
}

export function updatedPullRequestResult(url) {
  return {
    status: 'existing',
    url,
    message: `Updated existing Bridge pull request: ${url}`
  };
}

export function formatDuplicatePullRequestNotice(duplicates = []) {
  const list = Array.isArray(duplicates) ? duplicates.filter((entry) => entry?.number) : [];

  if (list.length === 0) {
    return '';
  }

  const older = list.filter((entry) => entry.older === true);
  const flagged = older.length > 0 ? older : list;
  const labeled = flagged
    .map((entry) => (entry.url ? `#${entry.number} (${entry.url})` : `#${entry.number}`))
    .join(', ');

  if (older.length > 0) {
    return `Older duplicate matching Bridge PR(s): ${labeled}`;
  }

  return `Other matching Bridge PR(s): ${labeled}`;
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
  bridgeVersion = '',
  scopeMeta = null
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

  if (scopeMeta && typeof scopeMeta === 'object') {
    lines.push('', buildBridgePrMarker(scopeMeta));
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

async function fetchPullRequestCommits({
  number,
  repository,
  cwd,
  runCommandFn
}) {
  const viewCommand = [
    'gh pr view',
    String(number),
    repository ? `--repo ${shellQuote(repository)}` : '',
    '--json commits'
  ]
    .filter(Boolean)
    .join(' ');
  const viewed = await runCommandFn(viewCommand, {
    cwd,
    allowFailure: true,
    quiet: true
  });

  if (!viewed.success) {
    throwPullRequestLookupError(
      `GitHub CLI could not load commits for pull request #${number}: ${formatGhOutput(viewed) || 'unknown error'}.`
    );
  }

  try {
    const parsed = JSON.parse(viewed.stdout || '{}');
    return Array.isArray(parsed.commits) ? parsed.commits : [];
  } catch {
    throwPullRequestLookupError(
      `GitHub CLI returned unreadable commit metadata for pull request #${number}.`
    );
  }
}

export async function findReusableBridgePullRequest({
  cwd,
  repoUrl,
  baseBranch,
  branchPrefix = 'bridge/patch',
  stagedDiff = '',
  scopeKey = '',
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
    `--limit ${PR_LIST_LIMIT}`,
    `--json ${PR_LIST_JSON_FIELDS}`
  ]
    .filter(Boolean)
    .join(' ');
  const listed = await runCommandFn(listCommand, {
    cwd,
    allowFailure: true,
    quiet: true
  });

  if (!listed.success) {
    throwPullRequestLookupError(
      `GitHub CLI could not list open pull requests: ${formatGhOutput(listed) || 'unknown error'}.`
    );
  }

  let pullRequests = [];

  try {
    pullRequests = JSON.parse(listed.stdout || '[]');
  } catch {
    throwPullRequestLookupError('GitHub CLI returned unreadable pull request list output.');
  }

  if (!Array.isArray(pullRequests)) {
    throwPullRequestLookupError('GitHub CLI returned unreadable pull request list output.');
  }

  const candidates = pullRequests
    .filter(
      (entry) =>
        isBridgePullRequest(entry, branchPrefix) &&
        (!baseBranch || !entry.baseRefName || entry.baseRefName === baseBranch)
    )
    .sort((left, right) => Number(left.number) - Number(right.number));

  if (candidates.length === 0) {
    return null;
  }

  const localFiles = filesFromDiff(stagedDiff);
  const localNormalized = normalizePullRequestDiff(stagedDiff);
  const matches = [];

  for (const candidate of candidates) {
    const commits = await fetchPullRequestCommits({
      number: candidate.number,
      repository,
      cwd,
      runCommandFn
    });
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

    const remoteDiff = remote.success ? remote.stdout || '' : '';
    const remoteNormalized = normalizePullRequestDiff(remoteDiff);
    const remoteFiles = filesFromDiff(remoteDiff);
    const remoteMarker = parseBridgePrMarker(candidate.body);
    const identical = Boolean(
      remote.success && localNormalized && remoteNormalized && localNormalized === remoteNormalized
    );
    const sameFiles = remote.success && localFiles.length > 0 && sameFileSet(localFiles, remoteFiles);
    const expectedAuthors = [candidate.author].filter(Boolean);
    const foreignCommits = getForeignPullRequestCommits(commits, { expectedAuthors });
    const decision = decidePullRequestReuse({
      identical,
      localScopeKey: scopeKey,
      remoteMarker,
      foreignCommits
    });

    matches.push({
      ...candidate,
      commits,
      identical,
      sameFiles,
      remoteMarker,
      foreignCommits,
      reuseAction: decision.action,
      reuseReason: decision.reason
    });
  }

  const selected =
    matches.find((entry) => entry.reuseAction === 'reuse_identical') ||
    matches.find((entry) => entry.reuseAction === 'update') ||
    matches[0] ||
    null;

  if (!selected) {
    return null;
  }

  const selectedNumber = Number(selected.number);
  const duplicatePullRequests = matches
    .filter((entry) => Number(entry.number) !== selectedNumber)
    .filter((entry) => entry.reuseAction === 'reuse_identical' || entry.reuseAction === 'update')
    .map((entry) => ({
      number: entry.number,
      url: entry.url,
      headRefName: entry.headRefName,
      reuseAction: entry.reuseAction,
      older: Number(entry.number) < selectedNumber
    }));

  return {
    ...selected,
    duplicatePullRequests
  };
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

  if (!repository) {
    return {
      status: 'failed',
      url: '',
      message: `Cannot update pull request #${number} without a GitHub repository URL.`
    };
  }

  const payload = {};

  if (body) {
    payload.body = body;
  }

  if (title) {
    payload.title = title;
  }

  if (Object.keys(payload).length === 0) {
    return {
      status: 'updated',
      url: '',
      message: `No pull request fields to update for #${number}`
    };
  }

  const inputPath = path.join(os.tmpdir(), `bridge-pr-update-${number}-${Date.now()}.json`);
  await fs.writeFile(inputPath, JSON.stringify(payload), 'utf8');

  try {
    const command = [
      'gh api',
      '-X PATCH',
      shellQuote(`repos/${repository}/pulls/${number}`),
      '--input',
      shellQuote(inputPath)
    ].join(' ');
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
  } finally {
    await fs.rm(inputPath, { force: true });
  }
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
  scopeMeta = null,
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
    bridgeVersion,
    scopeMeta
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
