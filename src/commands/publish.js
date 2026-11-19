import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  describeCiEnvironment,
  obtainGitHubToken,
  resolveCloudSettings,
  runUrlFor,
  uploadRunReport
} from '../core/cloud.js';
import { runCommand } from '../core/executor.js';
import {
  findNonDependencyManifestChanges,
  HandoffError,
  readHandoffBundle,
  validateBranchName
} from '../core/handoff.js';
import {
  buildBridgeCommitMessage,
  buildBridgePrMarker,
  createPullRequest,
  findReusableBridgePullRequest,
  formatDuplicatePullRequestNotice,
  getGitHubRepository,
  PullRequestLookupError,
  updatePullRequest
} from '../core/pullRequest.js';
import { error, info, line, success, warn } from '../ui/logger.js';

// `bridge publish <dir>` is the privileged half of a CI run. It never installs
// dependencies or runs repository scripts: it validates the handoff bundle from the
// update job, commits only manifests/lockfiles, pushes with a short-lived bot token
// and opens or refreshes the pull request.

const DEFAULT_COMMIT_AUTHOR = { name: 'Bridge', email: 'bridge@users.noreply.github.com' };

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

export function gitAuthEnv(token, serverUrl = 'https://github.com') {
  const base = String(serverUrl || 'https://github.com').replace(/\/+$/, '');
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

  // The first entry clears any credential actions/checkout persisted; the second adds ours.
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${base}/.extraheader`,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: `http.${base}/.extraheader`,
    GIT_CONFIG_VALUE_1: header,
    GH_TOKEN: token,
    GITHUB_TOKEN: token
  };
}

function pullRequestNumber(url) {
  const match = String(url || '').match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseDefaultBranch(lsRemoteOutput) {
  const match = String(lsRemoteOutput || '').match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
  return match ? match[1] : '';
}

async function appendStepSummary(env, lines) {
  const summaryPath = String(env.GITHUB_STEP_SUMMARY || '').trim();

  if (!summaryPath) {
    return;
  }

  try {
    await fs.appendFile(summaryPath, `${lines.filter((entry) => entry !== null).join('\n')}\n`);
  } catch {
    // The step summary is a convenience.
  }
}

function describeResult(publish) {
  switch (publish.status) {
    case 'created':
      return `Opened pull request ${publish.pullRequest?.url || ''}`.trim();
    case 'updated':
      return `Refreshed pull request ${publish.pullRequest?.url || ''}`.trim();
    case 'reused':
      return `Pull request already up to date: ${publish.pullRequest?.url || ''}`.trim();
    case 'up_to_date':
      return 'All dependencies are up to date.';
    case 'blocked':
      return `Blocked before any push: ${publish.message}`;
    case 'pushed':
      return `Pushed ${publish.branchName}${publish.message ? ` (${publish.message})` : ''}`;
    default:
      return `Failed: ${publish.message || 'unknown error'}`;
  }
}

export async function publishCommand({
  handoffDir,
  cwd = process.cwd(),
  env = process.env,
  branchPrefix = '',
  fetchImpl = globalThis.fetch,
  ghRunner = null,
  commandExistsFn = undefined,
  obtainToken = obtainGitHubToken,
  uploadReport = uploadRunReport
} = {}) {
  const settings = resolveCloudSettings(env);
  const requiredPrefix = String(branchPrefix || env.BRIDGE_BRANCH_PREFIX || 'bridge/').trim();
  const publish = {
    status: 'failed',
    startedAt: new Date().toISOString(),
    branchName: '',
    headSha: '',
    pullRequest: null,
    tokenSource: '',
    message: ''
  };
  let bundle = null;

  const finish = async (ok) => {
    publish.finishedAt = new Date().toISOString();
    let upload = { status: 'skipped', url: '', message: '' };
    const report = bundle?.report ? structuredClone(bundle.report) : null;

    if (report) {
      report.publish = publish;
      report.ci = report.ci?.provider === 'github-actions' ? report.ci : describeCiEnvironment(env);

      if (publish.pullRequest) {
        report.outcome = { ...(report.outcome || {}), pullRequest: publish.pullRequest };
      }

      if (['created', 'updated', 'reused', 'pushed'].includes(publish.status)) {
        report.run = { ...(report.run || {}), status: 'pushed' };
        report.git = {
          ...(report.git || {}),
          branchName: publish.branchName || report.git?.branchName || '',
          headSha: publish.headSha || report.git?.headSha || ''
        };
      } else if (publish.status === 'failed' && report.run?.status === 'handoff_ready') {
        report.run = { ...report.run, status: 'failed' };
        report.outcome = {
          ...(report.outcome || {}),
          failure: { message: `Publish failed: ${publish.message}` }
        };
      }

      upload = await uploadReport(settings, report, { fetchImpl });

      if (upload.status === 'uploaded') {
        success(`Run recorded in Bridge: ${upload.url}`);
      } else if (upload.status === 'failed') {
        warn(upload.message);
      }
    }

    const summary = bundle?.manifest?.summary || {};
    await appendStepSummary(env, [
      '### Bridge',
      '',
      `**${describeResult(publish)}**`,
      '',
      summary.direct !== undefined
        ? `- Dependency changes: ${summary.direct} direct, ${summary.transitive} transitive`
        : null,
      summary.cooldownDays
        ? `- Release-age cooldown: ${summary.cooldownDays} day(s), ${summary.cooldownChecked || 0} version(s) checked`
        : null,
      upload.url ? `- Run details: ${upload.url}` : null
    ]);

    return ok;
  };

  try {
    bundle = await readHandoffBundle(path.resolve(handoffDir || ''), {
      requiredBranchPrefix: requiredPrefix
    });
  } catch (bundleError) {
    publish.message = bundleError.message;
    error(bundleError.message);
    return finish(false);
  }

  const { manifest, files } = bundle;

  if (manifest.status !== 'ready') {
    publish.status = manifest.status;
    publish.message = manifest.message || '';

    if (manifest.status === 'up_to_date') {
      success('Nothing to publish: dependencies are already up to date.');
    } else if (manifest.status === 'blocked') {
      warn(`Nothing to publish. Bridge blocked this update: ${publish.message}`);
    } else {
      error(`Nothing to publish. The update job failed: ${publish.message}`);
    }

    return finish(manifest.status !== 'failed');
  }

  try {
    const repository = String(manifest.repository?.fullName || '').trim();
    const runningIn =
      String(env.GITHUB_REPOSITORY || '').trim() ||
      getGitHubRepository(
        (
          await runCommand('git remote get-url origin', {
            cwd,
            quiet: true,
            allowFailure: true
          })
        ).stdout.trim()
      );

    if (!repository || (runningIn && runningIn.toLowerCase() !== repository.toLowerCase())) {
      throw new HandoffError(
        `This handoff is for ${repository || 'an unknown repository'}, but publish is running in ${runningIn || 'an unknown repository'}.`
      );
    }

    const credentials = await obtainToken(settings, { repository, fetchImpl });
    publish.tokenSource = credentials.source;

    if (String(env.GITHUB_ACTIONS || '') === 'true') {
      // Keep the bot token out of the workflow log even if a command echoes it.
      process.stdout.write(`::add-mask::${credentials.token}\n`);
    }
    info(`Publishing as ${credentials.source === 'broker' ? 'the Bridge GitHub App' : credentials.source}.`);

    const authEnv = { ...env, ...gitAuthEnv(credentials.token, env.GITHUB_SERVER_URL) };
    const git = (args, options = {}) =>
      runCommand(`git ${args}`, { cwd, quiet: true, trusted: true, env: authEnv, ...options });
    const ghRun =
      ghRunner ||
      ((command, options = {}) =>
        command === 'gh auth status'
          ? Promise.resolve({ command, code: 0, stdout: '', stderr: '', success: true })
          : runCommand(command, { ...options, cwd, trusted: true, env: authEnv }));

    const remoteHead = await git('ls-remote --symref origin HEAD', { allowFailure: true });
    const defaultBranch = parseDefaultBranch(remoteHead.stdout) || String(manifest.base?.branch || '');
    const protectedBranches = new Set(
      [defaultBranch, 'main', 'master', ...(manifest.branch?.protectedBranches || [])].filter(Boolean)
    );
    let branchName = manifest.branch.name;

    if (protectedBranches.has(branchName)) {
      throw new HandoffError(`Refusing to push to protected branch "${branchName}".`);
    }

    const baseSha = manifest.base.sha;
    await git(`fetch --no-tags --depth=1 origin ${baseSha}`);
    await git(`-c advice.detachedHead=false checkout --force -B ${shellQuote(branchName)} ${baseSha}`);

    const root = await fs.realpath(cwd);

    for (const file of files) {
      const target = path.join(root, ...file.path.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      const parent = await fs.realpath(path.dirname(target));

      if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) {
        throw new HandoffError(`Refusing ${file.path}: it resolves outside the repository.`);
      }

      const existing = await fs.lstat(target).catch(() => null);

      if (existing && !existing.isFile()) {
        throw new HandoffError(`Refusing ${file.path}: the checked-out path is not a regular file.`);
      }

      if (path.posix.basename(file.path) === 'package.json') {
        const baseManifest = await git(`show ${shellQuote(`${baseSha}:${file.path}`)}`, {
          allowFailure: true
        });

        if (!baseManifest.success) {
          throw new HandoffError(`Refusing to add a new manifest: ${file.path}`);
        }

        const outsideDependencies = findNonDependencyManifestChanges(
          baseManifest.stdout,
          file.content.toString('utf8')
        );

        if (outsideDependencies.length > 0) {
          throw new HandoffError(
            `Refusing ${file.path}: fields outside dependency sections changed (${outsideDependencies.join(', ')}).`
          );
        }
      }

      await fs.writeFile(target, file.content);
    }

    await git(`add -- ${files.map((file) => shellQuote(file.path)).join(' ')}`);
    const nothingStaged = await git('diff --cached --quiet', { allowFailure: true });

    if (nothingStaged.success) {
      publish.status = 'up_to_date';
      publish.message = 'The changes already match the base commit.';
      success('Nothing to publish: the handoff matches the base commit.');
      return finish(true);
    }

    const stagedDiff = (await git('diff --cached')).stdout;
    const repoUrl = `https://github.com/${repository}`;
    const lookupPrefix = String(manifest.branch?.prefix || 'bridge/patch');
    let reusable = null;

    try {
      reusable = await findReusableBridgePullRequest({
        cwd,
        repoUrl,
        baseBranch: defaultBranch,
        branchPrefix: lookupPrefix,
        stagedDiff,
        scopeKey: manifest.scopeKey,
        runCommandFn: ghRun,
        ...(commandExistsFn ? { commandExistsFn } : {})
      });
    } catch (lookupError) {
      if (lookupError instanceof PullRequestLookupError) {
        throw new HandoffError(`Stopped without pushing. ${lookupError.message}`);
      }

      throw lookupError;
    }

    const duplicateNotice = formatDuplicatePullRequestNotice(reusable?.duplicatePullRequests);

    if (duplicateNotice) {
      warn(duplicateNotice);
    }

    if (reusable?.reuseAction === 'reuse_identical') {
      publish.status = 'reused';
      publish.branchName = reusable.headRefName;
      publish.pullRequest = {
        status: 'existing',
        reused: true,
        url: reusable.url,
        number: Number(reusable.number) || pullRequestNumber(reusable.url),
        message: `Existing Bridge pull request already has these changes: ${reusable.url}`
      };
      success(publish.pullRequest.message);
      return finish(true);
    }

    const author = credentials.commitAuthor?.email ? credentials.commitAuthor : {
      name: String(env.BRIDGE_COMMIT_NAME || DEFAULT_COMMIT_AUTHOR.name),
      email: String(env.BRIDGE_COMMIT_EMAIL || DEFAULT_COMMIT_AUTHOR.email)
    };
    const messageFile = path.join(os.tmpdir(), `bridge-commit-${process.pid}-${Date.now()}.txt`);
    await fs.writeFile(messageFile, buildBridgeCommitMessage(), 'utf8');

    try {
      await git(
        [
          `-c user.name=${shellQuote(author.name)}`,
          `-c user.email=${shellQuote(author.email)}`,
          '-c core.hooksPath=/dev/null',
          '-c commit.gpgsign=false',
          'commit --no-verify',
          `-F ${shellQuote(messageFile)}`
        ].join(' ')
      );
    } finally {
      await fs.rm(messageFile, { force: true });
    }

    publish.headSha = (await git('rev-parse HEAD')).stdout.trim();
    const marker = buildBridgePrMarker({ v: 1, scopeKey: manifest.scopeKey, headSha: publish.headSha });
    const body = `${manifest.pullRequest.body || 'Bridge dependency maintenance.'}\n\n${marker}`;
    const shouldUpdate = reusable?.reuseAction === 'update';

    if (shouldUpdate) {
      branchName = validateBranchName(reusable.headRefName, { requiredPrefix: requiredPrefix });
      const commits = Array.isArray(reusable.commits) ? reusable.commits : [];
      const leaseSha = String(commits[commits.length - 1]?.oid || '').trim();

      if (!/^[0-9a-f]{40}$/i.test(leaseSha)) {
        throw new HandoffError(`Could not read the current head of ${reusable.url}; refusing to force-push.`);
      }

      await git(
        `push --force-with-lease=${shellQuote(`refs/heads/${branchName}:${leaseSha}`)} origin ${shellQuote(`HEAD:refs/heads/${branchName}`)}`
      );
      publish.branchName = branchName;
      const edited = await updatePullRequest({
        cwd,
        number: reusable.number,
        repoUrl,
        body,
        runCommandFn: ghRun,
        ...(commandExistsFn ? { commandExistsFn } : {})
      });
      publish.status = 'updated';
      publish.pullRequest = {
        status: edited.status === 'updated' ? 'existing' : 'body_update_failed',
        reused: false,
        url: reusable.url,
        number: Number(reusable.number) || pullRequestNumber(reusable.url),
        message: edited.status === 'updated' ? `Updated ${reusable.url}` : edited.message
      };
      success(`Refreshed Bridge pull request: ${reusable.url}`);
      return finish(true);
    }

    const existingBranch = await git(`ls-remote --heads origin ${shellQuote(`refs/heads/${branchName}`)}`, {
      allowFailure: true
    });

    if (existingBranch.success && existingBranch.stdout.trim()) {
      const suffix = String(manifest.runId || Date.now()).split('-').pop() || String(Date.now());
      branchName = validateBranchName(`${branchName}-${suffix}`, { requiredPrefix: requiredPrefix });
    }

    await git(`push origin ${shellQuote(`HEAD:refs/heads/${branchName}`)}`);
    publish.branchName = branchName;
    publish.status = 'pushed';

    const pullRequest = await createPullRequest({
      cwd,
      branchName,
      baseBranch: defaultBranch,
      repoUrl,
      options: {
        enabled: manifest.pullRequest.enabled !== false,
        draft: manifest.pullRequest.draft === true,
        title: manifest.pullRequest.title || '',
        body
      },
      runCommandFn: ghRun,
      ...(commandExistsFn ? { commandExistsFn } : {})
    });
    publish.pullRequest = { ...pullRequest, number: pullRequestNumber(pullRequest.url) };

    if (['created', 'existing'].includes(pullRequest.status)) {
      publish.status = 'created';
      success(pullRequest.message);
    } else {
      publish.message = pullRequest.message;
      warn(pullRequest.message);
    }

    line();
    info(`Run: ${runUrlFor(settings, manifest.runId) || manifest.runId}`);
    return finish(true);
  } catch (publishError) {
    publish.status = 'failed';
    publish.message = publishError?.message || String(publishError);
    error(publish.message);

    if (publishError?.stderr) {
      line(String(publishError.stderr).trim().slice(0, 2000));
    }

    return finish(false);
  }
}
