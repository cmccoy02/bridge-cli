import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_BRANCH_PREFIX } from '../constants.js';
import { formatConfig, loadConfig } from '../core/configReader.js';
import {
  getActivityLogPath,
  logPhase,
  logRunEnd,
  logRunFailure,
  logRunStart,
  makeRunContext
} from '../core/activityLogger.js';
import { CommandExecutionError, runCommand } from '../core/executor.js';
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

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return '0ms';
  }

  if (ms < 1000) {
    return `${ms}ms`;
  }

  const totalSeconds = ms / 1000;

  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function shortSha(sha) {
  if (!sha) {
    return '(unknown)';
  }

  return sha.slice(0, 8);
}

function normalizeCommandOutput(text, limit = 400) {
  const trimmed = (text || '').trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed.length <= limit) {
    return trimmed;
  }

  return `${trimmed.slice(0, limit)}\n... [truncated]`;
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

async function runPhase({
  run,
  phase,
  spinnerText,
  successText,
  task,
  meta = {}
}) {
  const startedAt = Date.now();
  const spinner = createSpinner(spinnerText).start();

  try {
    const result = await task();
    const durationMs = Date.now() - startedAt;
    spinner.stop();
    success(`${successText} (${formatDuration(durationMs)})`);
    await logPhase(run, phase, 'success', {
      durationMs,
      ...meta
    });
    return result;
  } catch (phaseError) {
    const durationMs = Date.now() - startedAt;
    spinner.fail(spinnerText);
    await logPhase(run, phase, 'failed', {
      durationMs,
      error: phaseError.message,
      ...meta
    });
    throw phaseError;
  }
}

async function runCommandList({
  run,
  phase,
  title,
  commands,
  cwd,
  allowFailure = false,
  quiet = true
}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return [];
  }

  const results = [];
  line();
  info(`${title} (${commands.length} command${commands.length === 1 ? '' : 's'})`);

  for (const commandText of commands) {
    command(commandText);
    const startedAt = Date.now();
    const result = await runCommand(commandText, { cwd, allowFailure, quiet });
    const durationMs = Date.now() - startedAt;
    results.push({ ...result, durationMs });

    if (result.success) {
      success(`completed (${formatDuration(durationMs)})`);
    } else {
      warn(`failed but continuing (${formatDuration(durationMs)})`);
    }

    const output = normalizeCommandOutput(result.stderr || result.stdout);

    if (!result.success && output) {
      line(output);
    }
  }

  await logPhase(run, phase, 'success', {
    commandCount: commands.length,
    allowFailure
  });

  return results;
}

async function runOptionalScripts(run, title, scripts, cwd, groupName) {
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return;
  }
  await runCommandList({
    run,
    phase: groupName,
    title,
    commands: scripts,
    cwd,
    allowFailure: true,
    quiet: true
  });
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
  info(`Config: ${configPath}`);
  info(`Package manager: ${config.packageManager}`);
  info(`Log file: ${getActivityLogPath()}`);
  line();

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
    await runPhase({
      run,
      phase: 'copy',
      spinnerText: 'Copying repository...',
      successText: 'Copied to isolated environment',
      meta: { tempDir },
      task: async () => {
        await copyToIsolatedWorkspace(cwd, tempDir);
      }
    });
    info(`Isolated workspace: ${tempDir}`);

    let syncResult;
    try {
      syncResult = await runPhase({
        run,
        phase: 'sync',
        spinnerText: 'Syncing with origin...',
        successText: 'Fetched latest remote state',
        task: async () => {
          const result = await refreshFromOrigin(tempDir, { cleanLocal: true });
          baseBranch = result.branch || '';

          const configFileName = path.basename(configPath);
          const sourceConfigPath = path.join(cwd, configFileName);
          const copiedConfigPath = path.join(tempDir, configFileName);

          if (await fileExists(sourceConfigPath)) {
            await fs.copyFile(sourceConfigPath, copiedConfigPath);
          }

          return result;
        }
      });
    } catch (syncError) {
      warn(`Could not fast-forward to origin. Continuing with local snapshot: ${syncError.message}`);
      await logPhase(run, 'sync', 'warning', { message: syncError.message });
      syncResult = {
        hasOrigin: false,
        branch: '',
        beforeSha: '',
        afterSha: '',
        advancedBy: 0
      };
    }

    if (syncResult.hasOrigin) {
      const branchLabel = syncResult.branch || '(unknown)';
      info(
        `Base branch: ${branchLabel} | ${shortSha(syncResult.beforeSha)} -> ${shortSha(syncResult.afterSha)}`
      );
      if (syncResult.advancedBy > 0) {
        info(`Remote sync advanced ${syncResult.advancedBy} commit(s).`);
      } else if (syncResult.beforeSha === syncResult.afterSha) {
        info('Remote sync did not advance commits.');
      }
    } else {
      warn('No origin remote found; running against local snapshot.');
    }

    await runCommandList({
      run,
      phase: 'clean',
      title: 'Running clean commands',
      commands: config.cleanCommands,
      cwd: tempDir,
      allowFailure: false,
      quiet: true
    });

    const installResult = await runPhase({
      run,
      phase: 'install',
      spinnerText: 'Running install command...',
      successText: 'Fresh install complete',
      task: async () =>
        runCommand(config.installCommand, {
          cwd: tempDir,
          quiet: true
        }),
      meta: { command: config.installCommand }
    });
    line(normalizeCommandOutput(installResult.stdout, 220) || 'Install output: (no stdout)');

    const updateResult = await runPhase({
      run,
      phase: 'update',
      spinnerText: 'Running update command...',
      successText: 'Dependencies updated to latest non-breaking versions',
      task: async () =>
        runCommand(config.updateCommand, {
          cwd: tempDir,
          quiet: true
        }),
      meta: { command: config.updateCommand }
    });
    line(normalizeCommandOutput(updateResult.stdout, 220) || 'Update output: (no stdout)');

    await runPhase({
      run,
      phase: 'reinstall',
      spinnerText: 'Regenerating lockfile...',
      successText: 'Clean lockfile generated',
      task: async () => {
        await runCommandList({
          run,
          phase: 'reinstall_clean',
          title: 'Reinstall clean commands',
          commands: config.cleanCommands,
          cwd: tempDir,
          allowFailure: false,
          quiet: true
        });

        return runCommand(config.installCommand, { cwd: tempDir, quiet: true });
      },
      meta: { command: config.installCommand }
    });

    await runOptionalScripts(run, 'Running before scripts...', config.beforeScripts, tempDir, 'beforeScripts');
    await runOptionalScripts(run, 'Running after scripts...', config.afterScripts, tempDir, 'afterScripts');

    const gitPrepResult = await runPhase({
      run,
      phase: 'prepare_git',
      spinnerText: 'Preparing git changes...',
      successText: 'Git changes prepared',
      task: async () => {
        branchName = await resolveBranchName(tempDir, branchPrefix, dateStamp);
        await createBranch(tempDir, branchName);
        const addedConfig = await ensureBridgeConfigTracked(tempDir, config);
        await stageAll(tempDir);
        return { addedConfig };
      }
    });
    info(`Patch branch: ${branchName}`);
    if (gitPrepResult?.addedConfig) {
      info('Added bridge.config.json to patch branch because it was not tracked.');
    }

    if (!(await hasStagedChanges(tempDir))) {
      success('All dependencies are already up to date. Nothing to patch.');
      status = 'up_to_date';
      await logRunEnd(run, 'up_to_date', { branchName, baseBranch });
      return true;
    }

    const stagedFilesResult = await runCommand('git diff --staged --name-only', {
      cwd: tempDir,
      quiet: true
    });
    const stagedFiles = stagedFilesResult.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    changedFilesCount = stagedFiles.length;

    info(`Staged files (${changedFilesCount}):`);
    for (const stagedFile of stagedFiles) {
      line(`  - ${stagedFile}`);
    }

    await runPhase({
      run,
      phase: 'push',
      spinnerText: 'Committing and pushing branch...',
      successText: 'PR branch pushed. Open your repo to create the pull request.',
      task: async () => {
        await commitChanges(tempDir, 'bridge: update dependencies (non-breaking)');
        await pushBranch(tempDir, branchName);
      },
      meta: { branchName }
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
      info(`Cleaned isolated workspace: ${tempDir}`);
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
