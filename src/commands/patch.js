import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_BRANCH_PREFIX } from '../constants.js';
import { formatConfig, loadConfig } from '../core/configReader.js';
import {
  logPhase,
  logRunEnd,
  logRunFailure,
  logRunStart,
  makeRunContext
} from '../core/activityLogger.js';
import { CommandExecutionError, runCommand, runCommands } from '../core/executor.js';
import {
  commitChanges,
  createBranch,
  getOriginUrl,
  getCompareUrl,
  hasStagedChanges,
  pushBranch,
  refreshFromOrigin,
  resolveBranchName,
  stageAll
} from '../core/git.js';
import { printBanner } from '../ui/banner.js';
import { command, error, info, line, success, warn } from '../ui/logger.js';
import { createSpinner } from '../ui/spinner.js';
import { printSummary } from '../ui/summary.js';

function getDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sanitizeSegment(value) {
  const normalized = String(value || 'repo')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'repo';
}

function shouldExcludeFromCopy(sourcePath) {
  const name = path.basename(sourcePath);
  return name === 'node_modules' || name === '.venv' || name === 'venv';
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyToIsolatedWorkspace(sourceDir, destinationDir) {
  await fs.cp(sourceDir, destinationDir, {
    recursive: true,
    force: true,
    filter: (sourcePath) => {
      if (sourcePath === sourceDir) {
        return true;
      }

      if (sourcePath.startsWith(destinationDir)) {
        return false;
      }

      return !shouldExcludeFromCopy(sourcePath);
    }
  });
}

async function runPhase(spinnerText, successText, task) {
  const spinner = createSpinner(spinnerText).start();

  try {
    const result = await task();
    spinner.stop();
    success(successText);
    return result;
  } catch (phaseError) {
    spinner.fail(spinnerText);
    throw phaseError;
  }
}

async function runOptionalScripts(title, scripts, cwd, groupName) {
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return;
  }

  line();
  info(title);

  for (const script of scripts) {
    const spinner = createSpinner(script).start();
    const result = await runCommand(script, { cwd, allowFailure: true, quiet: true });

    if (result.success) {
      spinner.stop();
      success(`${groupName}: ${script}`);
      continue;
    }

    spinner.stop();
    warn(`${groupName} failed but patch will continue: ${script}`);

    if (result.stderr.trim()) {
      line(result.stderr.trim());
    }
  }
}

async function ensureBridgeConfigTracked(tempDir, config) {
  const tracked = await runCommand('git ls-files --error-unmatch bridge.config.json', {
    cwd: tempDir,
    allowFailure: true,
    quiet: true
  });

  if (tracked.success) {
    return false;
  }

  const configPath = path.join(tempDir, 'bridge.config.json');
  await fs.writeFile(configPath, `${formatConfig(config)}\n`, 'utf8');
  return true;
}

export async function patchCommand({ cwd = process.cwd() } = {}) {
  let config;
  let configPath = '';
  const run = makeRunContext('patch', cwd);

  try {
    ({ config, configPath } = await loadConfig(cwd));
  } catch (configError) {
    error(configError.message);
    await logRunFailure(run, configError);
    await logRunEnd(run, 'failed_preflight');
    return false;
  }

  await logRunStart(run, {
    packageManager: config.packageManager,
    hasRepoUrl: Boolean(config.repoUrl)
  });

  printBanner();

  const repoName = config.name || path.basename(cwd);
  const tempDir = path.join(os.tmpdir(), `bridge-${sanitizeSegment(repoName)}-${Date.now()}`);
  const branchPrefix = config.branchPrefix || DEFAULT_BRANCH_PREFIX;
  const dateStamp = getDateStamp();

  let branchName = '';
  let compareUrl = '';
  let status = 'failed';
  let changedFilesCount = 0;
  let baseBranch = '';

  try {
    await runPhase('Copying repository...', 'Copied to isolated environment', async () => {
      await copyToIsolatedWorkspace(cwd, tempDir);
      await logPhase(run, 'copy', 'success', { tempDir });
    });

    await runPhase('Syncing with origin...', 'Fetched latest remote state', async () => {
      try {
        const syncResult = await refreshFromOrigin(tempDir, { cleanLocal: true });
        baseBranch = syncResult.branch || '';

        const configFileName = path.basename(configPath);
        const sourceConfigPath = path.join(cwd, configFileName);
        const copiedConfigPath = path.join(tempDir, configFileName);

        if (await fileExists(sourceConfigPath)) {
          await fs.copyFile(sourceConfigPath, copiedConfigPath);
        }

        await logPhase(run, 'sync', 'success', {
          baseBranch
        });
      } catch (syncError) {
        warn(`Could not fast-forward to origin. Continuing with local snapshot: ${syncError.message}`);
        await logPhase(run, 'sync', 'warning', { message: syncError.message });
      }
    });

    await runPhase('Running clean commands...', 'Cleaned dependency artifacts', async () => {
      await runCommands(config.cleanCommands, { cwd: tempDir, quiet: true });
      await logPhase(run, 'clean', 'success');
    });

    await runPhase('Running install command...', 'Fresh install complete', async () => {
      await runCommand(config.installCommand, { cwd: tempDir, quiet: true });
      await logPhase(run, 'install', 'success');
    });

    await runPhase(
      'Running update command...',
      'Dependencies updated to latest non-breaking versions',
      async () => {
        await runCommand(config.updateCommand, { cwd: tempDir, quiet: true });
        await logPhase(run, 'update', 'success');
      }
    );

    await runPhase('Regenerating lockfile...', 'Clean lockfile generated', async () => {
      await runCommands(config.cleanCommands, { cwd: tempDir, quiet: true });
      await runCommand(config.installCommand, { cwd: tempDir, quiet: true });
      await logPhase(run, 'reinstall', 'success');
    });

    await runOptionalScripts('Running before scripts...', config.beforeScripts, tempDir, 'beforeScripts');
    await runOptionalScripts('Running after scripts...', config.afterScripts, tempDir, 'afterScripts');

    await runPhase('Preparing git changes...', 'Git changes prepared', async () => {
      branchName = await resolveBranchName(tempDir, branchPrefix, dateStamp);
      await createBranch(tempDir, branchName);
      const addedConfig = await ensureBridgeConfigTracked(tempDir, config);
      await stageAll(tempDir);
      await logPhase(run, 'prepare_git', 'success', {
        branchName,
        addedConfig
      });
    });

    if (!(await hasStagedChanges(tempDir))) {
      success('All dependencies are already up to date. Nothing to patch.');
      status = 'up_to_date';
      await logRunEnd(run, 'up_to_date', { branchName });
      return true;
    }

    const stagedFilesResult = await runCommand('git diff --staged --name-only', {
      cwd: tempDir,
      quiet: true
    });
    changedFilesCount = stagedFilesResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean).length;

    await runPhase('Committing and pushing branch...', 'PR branch pushed. Open your repo to create the pull request.', async () => {
      await commitChanges(tempDir, 'bridge: update dependencies (non-breaking)');
      await pushBranch(tempDir, branchName);
      await logPhase(run, 'push', 'success', { branchName });
    });

    const originUrl = await getOriginUrl(tempDir);
    compareUrl = getCompareUrl(originUrl || config.repoUrl, branchName);

    if (compareUrl) {
      line(compareUrl);
    }

    status = 'pushed';
    await logRunEnd(run, 'pushed', {
      branchName,
      baseBranch,
      compareUrl,
      changedFilesCount
    });
    return true;
  } catch (patchError) {
    if (patchError instanceof CommandExecutionError) {
      error(`Command failed: ${patchError.command}`);
      command(patchError.command);

      if (patchError.stderr.trim()) {
        line(patchError.stderr.trim());
      }
    } else {
      error(patchError.message);
    }

    await logRunFailure(run, patchError, { branchName });
    await logRunEnd(run, 'failed', { branchName });
    return false;
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      warn(`Failed to delete temp directory: ${cleanupError.message}`);
    }

    if (status === 'pushed') {
      printSummary(
        [
          'Bridge complete.',
          baseBranch ? `Base: ${baseBranch}` : 'Base: (local snapshot)',
          `Branch: ${branchName}`,
          `Files changed: ${changedFilesCount}`,
          compareUrl ? `Compare: ${compareUrl}` : 'Compare URL unavailable.',
          'Review your changes and merge when ready.'
        ],
        'Bridge complete'
      );
    }

    if (status === 'up_to_date') {
      printSummary(
        [
          'Bridge complete.',
          baseBranch ? `Base: ${baseBranch}` : 'Base: (local snapshot)',
          `Branch: ${branchName}`,
          'All dependencies are already up to date.'
        ],
        'Bridge complete'
      );
    }
  }
}
