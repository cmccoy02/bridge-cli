import simpleGit from 'simple-git';

function getGit(cwd) {
  return simpleGit({ baseDir: cwd });
}

export async function cloneRepository(repoUrl, destination) {
  const git = simpleGit();
  await git.clone(repoUrl, destination, ['--depth', '1']);
}

export async function createBranch(cwd, branchName) {
  await getGit(cwd).checkoutLocalBranch(branchName);
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

export async function pushBranch(cwd, branchName) {
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

export async function refreshFromOrigin(cwd, { cleanLocal = false } = {}) {
  const git = getGit(cwd);
  const remotes = await git.getRemotes();
  const hasOrigin = remotes.some((remote) => remote.name === 'origin');

  if (!hasOrigin) {
    return { hasOrigin: false, updated: false, branch: '' };
  }

  if (cleanLocal) {
    await cleanWorkingTree(cwd);
  }

  await git.fetch('origin');

  const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();

  if (!branch || branch === 'HEAD') {
    return { hasOrigin: true, updated: true, branch: '' };
  }

  await git.pull('origin', branch, { '--ff-only': null });
  return { hasOrigin: true, updated: true, branch };
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
