import simpleGit from 'simple-git';

function getGit(cwd) {
  return simpleGit({ baseDir: cwd });
}

function normalizeBranchName(branchName) {
  return typeof branchName === 'string' ? branchName.trim() : '';
}

function normalizeBranchList(branches = []) {
  if (!Array.isArray(branches)) {
    return [];
  }

  return branches
    .map((branch) => normalizeBranchName(branch))
    .filter((branch) => branch.length > 0);
}

function protectedBranchSet(defaultBranch, protectedBranches = []) {
  return new Set([
    normalizeBranchName(defaultBranch),
    ...normalizeBranchList(protectedBranches)
  ].filter(Boolean));
}

async function getHeadSha(git) {
  try {
    return (await git.revparse(['--short', 'HEAD'])).trim();
  } catch {
    return '';
  }
}

async function getCommitDistance(git, from, to) {
  if (!from || !to || from === to) {
    return 0;
  }

  try {
    const count = (await git.raw(['rev-list', '--count', `${from}..${to}`])).trim();
    return Number.parseInt(count, 10) || 0;
  } catch {
    return 0;
  }
}

export async function cloneRepository(repoUrl, destination) {
  const git = simpleGit();
  await git.clone(repoUrl, destination, ['--depth', '1']);
}

export async function createBranch(cwd, branchName) {
  await getGit(cwd).checkoutLocalBranch(branchName);
}

export async function getCurrentBranch(cwd) {
  return (await getGit(cwd).revparse(['--abbrev-ref', 'HEAD'])).trim();
}

export async function stageAll(cwd) {
  await getGit(cwd).add(['-A']);
}

export async function hasStagedChanges(cwd) {
  const output = await getGit(cwd).raw(['diff', '--staged', '--name-only']);
  return output.trim().length > 0;
}

export async function commitChanges(cwd, message) {
  await getGit(cwd).commit(message);
}

export async function assertSafeWorkingBranch(
  cwd,
  { branchName, defaultBranch, protectedBranches = [] }
) {
  const expectedBranch = normalizeBranchName(branchName);
  const currentBranch = await getCurrentBranch(cwd);
  const neverPush = protectedBranchSet(defaultBranch, protectedBranches);

  if (!expectedBranch) {
    throw new Error('Safety check failed: Bridge working branch is empty. Aborting without pushing.');
  }

  if (currentBranch !== expectedBranch) {
    throw new Error(
      `Safety check failed: expected Bridge branch "${expectedBranch}" before commit/push, but current branch is "${currentBranch}". Aborting without pushing.`
    );
  }

  if (neverPush.has(currentBranch) || neverPush.has(expectedBranch)) {
    throw new Error(
      `Safety check failed: "${expectedBranch}" is protected and cannot be pushed by Bridge. Aborting without pushing.`
    );
  }

  return {
    currentBranch,
    protectedBranches: [...neverPush]
  };
}

export async function pushBridgeBranch(
  cwd,
  { branchName, defaultBranch, protectedBranches = [] }
) {
  await assertSafeWorkingBranch(cwd, { branchName, defaultBranch, protectedBranches });
  await getGit(cwd).push('origin', branchName);
}

export async function getOriginUrl(cwd) {
  const remotes = await getGit(cwd).getRemotes(true);
  const origin = remotes.find((remote) => remote.name === 'origin');

  if (!origin || !origin.refs) {
    return '';
  }

  return origin.refs.push || origin.refs.fetch || '';
}

export async function cleanWorkingTree(cwd) {
  const git = getGit(cwd);
  await git.raw(['reset', '--hard', 'HEAD']);
  await git.raw(['clean', '-fd']);
}

async function remoteBranchRefExists(git, remoteBranchRef) {
  try {
    await git.raw(['show-ref', '--verify', '--quiet', remoteBranchRef]);
    return true;
  } catch {
    return false;
  }
}

async function detectRemoteDefaultBranch(git) {
  try {
    const remoteHead = (
      await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    ).trim();

    if (remoteHead.startsWith('origin/')) {
      return remoteHead.replace(/^origin\//, '');
    }
  } catch {
    // Fall through to asking the remote directly.
  }

  try {
    const remoteShow = await git.raw(['remote', 'show', 'origin']);
    const headBranchLine = remoteShow
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('HEAD branch:'));

    if (headBranchLine) {
      const branch = headBranchLine.replace(/^HEAD branch:\s*/, '').trim();

      if (branch && branch !== '(unknown)') {
        return branch;
      }
    }
  } catch {
    // The caller turns an empty result into an actionable error.
  }

  return '';
}

async function resolveDefaultBaseBranch(git, configuredDefaultBranch) {
  const configured = normalizeBranchName(configuredDefaultBranch);

  if (configured) {
    return {
      branch: configured,
      detected: false
    };
  }

  const detected = await detectRemoteDefaultBranch(git);

  if (detected) {
    return {
      branch: detected,
      detected: true
    };
  }

  throw new Error(
    'Could not determine origin default branch. Add "defaultBranch": "main" (or "master") to bridge.config.json, or run `git remote set-head origin -a` in the repository and try again.'
  );
}

async function deleteLocalBranchesExcept(git, keepBranch) {
  const branches = (await git.raw(['branch', '--format=%(refname:short)']))
    .split('\n')
    .map((branch) => branch.trim())
    .filter(Boolean);
  const deletedBranches = [];

  for (const branch of branches) {
    if (branch === keepBranch) {
      continue;
    }

    await git.raw(['branch', '-D', branch]);
    deletedBranches.push(branch);
  }

  return deletedBranches;
}

export async function prepareCleanBase(
  cwd,
  { configuredDefaultBranch = '', protectedBranches = [], branchPrefix, dateStamp }
) {
  const git = getGit(cwd);
  const remotes = await git.getRemotes();
  const hasOrigin = remotes.some((remote) => remote.name === 'origin');

  if (!hasOrigin) {
    throw new Error('No origin remote found. Add an origin remote before running `bridge patch`.');
  }

  const beforeSha = await getHeadSha(git);
  await git.fetch('origin');
  const { branch: defaultBranch, detected } = await resolveDefaultBaseBranch(
    git,
    configuredDefaultBranch
  );

  if (!(await remoteBranchRefExists(git, `refs/remotes/origin/${defaultBranch}`))) {
    throw new Error(
      `Default branch "${defaultBranch}" was not found on origin. Update bridge.config.json or check the remote.`
    );
  }

  const branchName = await resolveBranchName(cwd, branchPrefix, dateStamp);
  const neverPush = protectedBranchSet(defaultBranch, protectedBranches);

  if (neverPush.has(branchName)) {
    throw new Error(
      `Refusing to create Bridge branch "${branchName}" because it is protected. Change branchPrefix in bridge.config.json.`
    );
  }

  await git.raw(['checkout', '--force', defaultBranch]);
  await git.raw(['reset', '--hard', `origin/${defaultBranch}`]);
  await git.pull('origin', defaultBranch);
  await git.raw(['reset', '--hard', `origin/${defaultBranch}`]);
  await git.raw(['clean', '-fd']);
  const deletedBranches = await deleteLocalBranchesExcept(git, defaultBranch);
  await git.checkoutLocalBranch(branchName);
  const afterSha = await getHeadSha(git);

  return {
    hasOrigin: true,
    updated: true,
    branch: defaultBranch,
    branchName,
    beforeSha,
    afterSha,
    advancedBy: await getCommitDistance(git, beforeSha, afterSha),
    deletedBranches,
    detectedDefaultBranch: detected
  };
}

export async function remoteBranchExists(cwd, branchName) {
  const output = await getGit(cwd).listRemote(['--heads', 'origin', branchName]);
  return output.trim().length > 0;
}

export async function resolveBranchName(cwd, branchPrefix, dateStamp) {
  const base = `${branchPrefix}-${dateStamp}`;

  if (!(await remoteBranchExists(cwd, base))) {
    return base;
  }

  let counter = 2;

  while (await remoteBranchExists(cwd, `${base}-${counter}`)) {
    counter += 1;
  }

  return `${base}-${counter}`;
}

export async function isPathTracked(cwd, filePath) {
  try {
    await getGit(cwd).raw(['ls-files', '--error-unmatch', filePath]);
    return true;
  } catch {
    return false;
  }
}

export async function isPathInHistory(cwd, filePath) {
  try {
    const output = await getGit(cwd).raw(['log', '--format=%H', '--', filePath]);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

export async function isPathTrackedOrInHistory(cwd, filePath) {
  return (await isPathTracked(cwd, filePath)) || (await isPathInHistory(cwd, filePath));
}

export function normalizeRepoWebUrl(repoUrl) {
  if (typeof repoUrl !== 'string' || repoUrl.trim().length === 0) {
    return '';
  }

  const trimmed = repoUrl.trim();

  if (trimmed.startsWith('git@')) {
    const match = trimmed.match(/^git@([^:]+):(.+)$/);

    if (!match) {
      return trimmed.replace(/\.git$/, '');
    }

    const host = match[1];
    const path = match[2].replace(/\.git$/, '');
    return `https://${host}/${path}`;
  }

  if (trimmed.startsWith('ssh://git@')) {
    const withoutPrefix = trimmed.replace('ssh://git@', '');
    const slashIndex = withoutPrefix.indexOf('/');

    if (slashIndex === -1) {
      return trimmed.replace(/\.git$/, '');
    }

    const host = withoutPrefix.slice(0, slashIndex);
    const repoPath = withoutPrefix.slice(slashIndex + 1).replace(/\.git$/, '');
    return `https://${host}/${repoPath}`;
  }

  return trimmed.replace(/\.git$/, '');
}

export function getCompareUrl(repoUrl, branchName) {
  const webUrl = normalizeRepoWebUrl(repoUrl);

  if (!webUrl) {
    return '';
  }

  return `${webUrl}/compare/${branchName}`;
}

export function inferRepoName(repoUrl) {
  if (!repoUrl || typeof repoUrl !== 'string') {
    return 'repository';
  }

  const normalized = repoUrl
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '');

  const parts = normalized.split(/[/:]/).filter(Boolean);
  return parts.at(-1) || 'repository';
}
