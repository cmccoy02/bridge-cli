import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_BRANCH_PREFIX, PACKAGE_MANAGER_PRESETS } from '../constants.js';
import { formatConfig, loadConfig } from '../core/configReader.js';
import { cleanupLocalConfigAfterSuccessfulPush } from '../core/configLifecycle.js';
import {
  getActivityLogPath,
  logDepDelta,
  logDepDeltaSummary,
  logPhase,
  logRunEnd,
  logRunFailure,
  logRunStart,
  makeRunContext
} from '../core/activityLogger.js';
import { CommandExecutionError, runCommand } from '../core/executor.js';
import {
  assertSafeWorkingBranch,
  commitChanges,
  getOriginUrl,
  getCompareUrl,
  hasStagedChanges,
  isPathTracked,
  prepareCleanBase,
  pushBridgeBranch,
  stageAll
} from '../core/git.js';
import {
  computeDepDeltas,
  createDepDeltaSummary,
  mergeDepDeltaSummaries,
  parseDirectDeps
} from '../core/lockfileDiff.js';
import {
  formatPythonRequirementsSummary,
  runPythonRequirementsWildcardUpdate
} from '../core/pythonRequirementsUpdater.js';
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

function normalizePhaseMeta(meta = {}) {
  const normalized = { ...meta };

  if ('command' in normalized && !('phaseCommand' in normalized)) {
    normalized.phaseCommand = normalized.command;
    delete normalized.command;
  }

  return normalized;
}

function normalizeScopePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '' || rawPath.trim() === '.') {
    return '.';
  }

  return rawPath.trim().replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
}

function scopeLabel(scopePath) {
  return scopePath === '.' ? 'root' : scopePath;
}

function buildPatchScopes(config) {
  const rootScope = {
    path: '.',
    packageManager: config.packageManager || '',
    installCommand: config.installCommand,
    updateCommand: config.updateCommand,
    cleanCommands: Array.isArray(config.cleanCommands) ? config.cleanCommands : [],
    beforeScripts: Array.isArray(config.beforeScripts) ? config.beforeScripts : [],
    afterScripts: Array.isArray(config.afterScripts) ? config.afterScripts : []
  };

  const nestedScopes = Array.isArray(config.scopes)
    ? config.scopes.map((scope) => ({
        ...scope,
        path: normalizeScopePath(scope.path)
      }))
    : [];

  return [rootScope, ...nestedScopes];
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

async function readTextFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function resolveScopePreset(scope) {
  if (!scope || typeof scope.packageManager !== 'string') {
    return null;
  }

  return PACKAGE_MANAGER_PRESETS[scope.packageManager] || null;
}

function formatDeltaSummaryLine(summary) {
  if (!summary) {
    return 'Deltas: 0 direct, 0 transitive (0 patch / 0 minor / 0 major / 0 other)';
  }

  return `Deltas: ${summary.directChanged} direct, ${summary.transitiveChanged} transitive (${summary.byBump.patch} patch / ${summary.byBump.minor} minor / ${summary.byBump.major} major / ${summary.byBump.other} other)`;
}

function scopeUpdateStrategy(scope, preset) {
  return scope.updateStrategy || preset?.updateStrategy || '';
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
      ...normalizePhaseMeta(meta)
    });
    return result;
  } catch (phaseError) {
    const durationMs = Date.now() - startedAt;
    spinner.fail(spinnerText);
    await logPhase(run, phase, 'failed', {
      durationMs,
      error: phaseError.message,
      ...normalizePhaseMeta(meta)
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

async function runScopeWorkflow({ run, tempDir, scope, repoName }) {
  const relativePath = normalizeScopePath(scope.path);
  const label = scopeLabel(relativePath);
  const scopeDir = relativePath === '.' ? tempDir : path.join(tempDir, relativePath);
  const scopePreset = resolveScopePreset(scope);
  const updateStrategy = scopeUpdateStrategy(scope, scopePreset);
  const lockfile = scope.lockfile || scopePreset?.lockfile || null;
  const lockfileFormat = scope.lockfileFormat || scopePreset?.lockfileFormat || null;
  const manifest = scope.manifest || scopePreset?.manifest || null;
  const lockfilePath = lockfile ? path.join(scopeDir, lockfile) : '';
  const manifestPath = manifest ? path.join(scopeDir, manifest) : '';
  const hasMetricTarget = Boolean(lockfile && lockfileFormat);
  let shouldCollectMetrics = hasMetricTarget;
  let beforeLockfileContent = null;
  let metricsSummary = createDepDeltaSummary();

  if (!(await fileExists(scopeDir))) {
    throw new Error(`Scope path does not exist: ${relativePath}`);
  }

  line();
  info(`Scope: ${label}`);
  if (scope.packageManager) {
    info(`Scope manager: ${scope.packageManager}`);
  }
  if (relativePath !== '.' && (await fileExists(path.join(scopeDir, '.git')))) {
    warn(
      `Nested git metadata detected in ${relativePath}. Bridge will run commands there, but parent commits may only capture submodule pointer changes.`
    );
  }

  await runCommandList({
    run,
    phase: `clean:${label}`,
    title: 'Running clean commands',
    commands: scope.cleanCommands,
    cwd: scopeDir,
    allowFailure: false,
    quiet: true
  });

  const installResult = await runPhase({
    run,
    phase: `install:${label}`,
    spinnerText: `Running install command (${label})...`,
    successText: 'Fresh install complete',
    task: async () =>
      runCommand(scope.installCommand, {
        cwd: scopeDir,
        quiet: true
      }),
    meta: { command: scope.installCommand, scope: label }
  });
  line(normalizeCommandOutput(installResult.stdout, 220) || 'Install output: (no stdout)');

  if (hasMetricTarget) {
    try {
      beforeLockfileContent = await readTextFileIfExists(lockfilePath);
    } catch (beforeMetricsError) {
      shouldCollectMetrics = false;
      await logPhase(run, `metrics:${label}`, 'warning', {
        scope: label,
        lockfile,
        message: `Failed to read lockfile before update; skipping dep delta metrics: ${beforeMetricsError.message}`
      });
    }
  }

  const updateResult = await runPhase({
    run,
    phase: `update:${label}`,
    spinnerText: `Running update command (${label})...`,
    successText: 'Dependencies updated to latest non-breaking versions',
    task: async () => {
      if (updateStrategy === 'python-requirements-wildcard') {
        return runPythonRequirementsWildcardUpdate({
          cwd: scopeDir,
          runId: `${run.runId}-${label}`
        });
      }

      return runCommand(scope.updateCommand, {
        cwd: scopeDir,
        quiet: true
      });
    },
    meta: { command: scope.updateCommand, scope: label }
  });
  if (updateResult.pythonRequirementsSummary) {
    printSummary(
      formatPythonRequirementsSummary(updateResult.pythonRequirementsSummary),
      'Python requirements'
    );
  } else {
    line(normalizeCommandOutput(updateResult.stdout, 220) || 'Update output: (no stdout)');
  }

  await runPhase({
    run,
    phase: `reinstall:${label}`,
    spinnerText: `Regenerating lockfile (${label})...`,
    successText: 'Clean lockfile generated',
    task: async () => {
      await runCommandList({
        run,
        phase: `reinstall_clean:${label}`,
        title: 'Reinstall clean commands',
        commands: scope.cleanCommands,
        cwd: scopeDir,
        allowFailure: false,
        quiet: true
      });

      return runCommand(scope.installCommand, { cwd: scopeDir, quiet: true });
    },
    meta: { command: scope.installCommand, scope: label }
  });

  if (shouldCollectMetrics) {
    if (beforeLockfileContent === null) {
      await logPhase(run, `metrics:${label}`, 'note', {
        scope: label,
        lockfile,
        message: `Lockfile ${lockfile} was missing before update; skipping dep delta metrics for this scope.`
      });
    } else {
      try {
        const afterLockfileContent = await readTextFileIfExists(lockfilePath);

        if (afterLockfileContent === null) {
          await logPhase(run, `metrics:${label}`, 'note', {
            scope: label,
            lockfile,
            message: `Lockfile ${lockfile} is missing after reinstall; skipping dep delta metrics for this scope.`
          });
        } else {
          const manifestWarnings = [];
          const manifestContent = manifestPath ? await readTextFileIfExists(manifestPath) : null;
          const directDeps = parseDirectDeps(manifestContent || '', manifest, {
            onWarning: (warningError) => {
              manifestWarnings.push(warningError.message);
            }
          });

          if (manifestWarnings.length > 0) {
            await logPhase(run, `metrics:${label}`, 'warning', {
              scope: label,
              manifest,
              message: `Failed to fully parse direct dependencies: ${manifestWarnings[0]}`
            });
          }

          const { deltas, summary } = computeDepDeltas({
            beforeContent: beforeLockfileContent,
            afterContent: afterLockfileContent,
            lockfileFormat,
            directDeps
          });

          metricsSummary = mergeDepDeltaSummaries(metricsSummary, summary);

          for (const delta of deltas) {
            await logDepDelta(run, {
              repo: repoName,
              manager: scope.packageManager,
              scope: label,
              name: delta.name,
              from: delta.from,
              to: delta.to,
              bump: delta.bump,
              kind: delta.kind,
              // TODO(v2): causal attribution requires the resolved dependency graph.
              blastRadius: null,
              causedBy: null
            });
          }

          await logPhase(run, `metrics:${label}`, 'success', {
            scope: label,
            lockfile,
            totalChanged: summary.totalChanged,
            added: summary.added,
            removed: summary.removed,
            directChanged: summary.directChanged,
            transitiveChanged: summary.transitiveChanged
          });
        }
      } catch (metricsError) {
        await logPhase(run, `metrics:${label}`, 'warning', {
          scope: label,
          lockfile,
          message: `Dependency delta metrics failed but patch will continue: ${metricsError.message}`
        });
      }
    }
  }

  await runOptionalScripts(
    run,
    `Running before scripts (${label})...`,
    scope.beforeScripts,
    scopeDir,
    `beforeScripts:${label}`
  );
  await runOptionalScripts(
    run,
    `Running after scripts (${label})...`,
    scope.afterScripts,
    scopeDir,
    `afterScripts:${label}`
  );

  return metricsSummary;
}

async function writeConfigFile(configPath, config) {
  await fs.writeFile(configPath, `${formatConfig(config)}\n`, 'utf8');
}

async function restoreLoadedConfig({ sourceConfigPath, tempConfigPath }) {
  if (await fileExists(sourceConfigPath)) {
    await fs.copyFile(sourceConfigPath, tempConfigPath);
    return true;
  }

  return false;
}

async function ensureBridgeConfigIncluded(tempDir, configFileName, config) {
  if (await isPathTracked(tempDir, configFileName)) {
    return false;
  }

  const configPath = path.join(tempDir, configFileName);

  if (!(await fileExists(configPath))) {
    await writeConfigFile(configPath, config);
  }

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
  run.repo = repoName;
  const tempDir = path.join(os.tmpdir(), `bridge-${sanitizeSegment(repoName)}-${Date.now()}`);
  const branchPrefix = config.branchPrefix || DEFAULT_BRANCH_PREFIX;
  const dateStamp = getDateStamp();
  const configFileName = path.basename(configPath);
  let depDeltaSummary = createDepDeltaSummary();

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

    const sourceConfigPath = path.join(cwd, configFileName);
    const copiedConfigPath = path.join(tempDir, configFileName);
    const configuredDefaultBranch = config.defaultBranch || '';
    const protectedBranches = config.protectedBranches || [];

    const cleanBaseResult = await runPhase({
      run,
      phase: 'clean_base',
      spinnerText: 'Preparing clean default branch base...',
      successText: 'Clean base and Bridge branch ready',
      task: async () => {
        const result = await prepareCleanBase(tempDir, {
          configuredDefaultBranch,
          protectedBranches,
          branchPrefix,
          dateStamp
        });
        baseBranch = result.branch;
        branchName = result.branchName;

        await restoreLoadedConfig({
          sourceConfigPath,
          tempConfigPath: copiedConfigPath
        });

        if (!configuredDefaultBranch && result.branch) {
          config = {
            ...config,
            defaultBranch: result.branch
          };
          await writeConfigFile(copiedConfigPath, config);
        }

        return result;
      }
    });

    info(
      `Base branch: ${cleanBaseResult.branch} | ${shortSha(cleanBaseResult.beforeSha)} -> ${shortSha(cleanBaseResult.afterSha)}`
    );
    info(`Patch branch: ${branchName}`);

    if (cleanBaseResult.detectedDefaultBranch) {
      info(`Detected and recorded default branch: ${cleanBaseResult.branch}`);
    }

    if (cleanBaseResult.deletedBranches.length > 0) {
      info(`Deleted local temp branches: ${cleanBaseResult.deletedBranches.join(', ')}`);
    }

    if (cleanBaseResult.advancedBy > 0) {
      info(`Remote sync advanced ${cleanBaseResult.advancedBy} commit(s).`);
    } else if (cleanBaseResult.beforeSha === cleanBaseResult.afterSha) {
      info('Remote sync did not advance commits.');
    } else {
      info('Remote sync reset the temp workspace to the default branch tip.');
    }

    await logPhase(run, 'clean_base_details', 'success', {
      baseBranch,
      branchName,
      detectedDefaultBranch: cleanBaseResult.detectedDefaultBranch,
      deletedBranches: cleanBaseResult.deletedBranches
    });

    const scopes = buildPatchScopes(config);
    info(`Update scopes: ${scopes.length}`);

    for (const scope of scopes) {
      const scopeSummary = await runScopeWorkflow({
        run,
        tempDir,
        scope,
        repoName
      });
      depDeltaSummary = mergeDepDeltaSummaries(depDeltaSummary, scopeSummary);
    }

    await logDepDeltaSummary(run, {
      repo: repoName,
      totalChanged: depDeltaSummary.totalChanged,
      added: depDeltaSummary.added,
      removed: depDeltaSummary.removed,
      directChanged: depDeltaSummary.directChanged,
      transitiveChanged: depDeltaSummary.transitiveChanged,
      byBump: { ...depDeltaSummary.byBump }
    });

    const gitPrepResult = await runPhase({
      run,
      phase: 'prepare_git',
      spinnerText: 'Preparing git changes...',
      successText: 'Git changes prepared',
      task: async () => {
        const addedConfig = await ensureBridgeConfigIncluded(tempDir, configFileName, config);
        await stageAll(tempDir);
        return { addedConfig };
      }
    });
    if (gitPrepResult?.addedConfig) {
      info(`Added ${configFileName} to patch branch because it was not tracked.`);
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
        await assertSafeWorkingBranch(tempDir, {
          branchName,
          defaultBranch: baseBranch,
          protectedBranches: config.protectedBranches
        });
        await commitChanges(tempDir, 'bridge: update dependencies (non-breaking)');
        await pushBridgeBranch(tempDir, {
          branchName,
          defaultBranch: baseBranch,
          protectedBranches: config.protectedBranches
        });
      },
      meta: { branchName, baseBranch }
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
      const configCleanup = await cleanupLocalConfigAfterSuccessfulPush(cwd, configFileName, {
        onWarning: (cleanupError) => {
          warn(`Could not clean up ${configFileName}: ${cleanupError.message}`);
        }
      });

      if (configCleanup.removed) {
        info(`Removed local untracked ${configFileName} after successful push.`);
      }
    }

    if (status === 'pushed') {
      printSummary(
        [
          'Bridge complete.',
          baseBranch ? `Base: ${baseBranch}` : 'Base: (local snapshot)',
          `Branch: ${branchName}`,
          formatDeltaSummaryLine(depDeltaSummary),
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
          formatDeltaSummaryLine(depDeltaSummary),
          'All dependencies are already up to date.'
        ],
        'Bridge complete'
      );
    }
  }
}
