import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_BRANCH_PREFIX } from '../constants.js';
import { loadConfig } from '../core/configReader.js';
import { CommandExecutionError, runCommand, runCommands } from '../core/executor.js';
import {
  cloneRepository,
  commitChanges,
  createBranch,
  getCompareUrl,
  hasStagedChanges,
  inferRepoName,
  pushBranch,
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

export async function patchCommand({ cwd = process.cwd() } = {}) {
  let config;

  try {
    ({ config } = await loadConfig(cwd));
  } catch (configError) {
    error(configError.message);
    return false;
  }

  printBanner();

  const repoName = config.name || inferRepoName(config.repoUrl);
  const tempDir = path.join(os.tmpdir(), `bridge-${sanitizeSegment(repoName)}-${Date.now()}`);
  const branchPrefix = config.branchPrefix || DEFAULT_BRANCH_PREFIX;
  const dateStamp = getDateStamp();

  let branchName = '';
  let compareUrl = '';
  let status = 'failed';

  try {
    await runPhase('Cloning repository...', 'Cloned to isolated environment', async () => {
      try {
        await cloneRepository(config.repoUrl, tempDir);
      } catch {
        throw new Error('Could not clone repository. Check your repoUrl and Git credentials.');
      }
    });

    await runPhase('Running clean commands...', 'Cleaned dependency artifacts', async () => {
      await runCommands(config.cleanCommands, { cwd: tempDir, quiet: true });
    });

    await runPhase('Running install command...', 'Fresh install complete', async () => {
      await runCommand(config.installCommand, { cwd: tempDir, quiet: true });
    });

    await runPhase(
      'Running update command...',
      'Dependencies updated to latest non-breaking versions',
      async () => {
        await runCommand(config.updateCommand, { cwd: tempDir, quiet: true });
      }
    );

    await runPhase('Regenerating lockfile...', 'Clean lockfile generated', async () => {
      await runCommands(config.cleanCommands, { cwd: tempDir, quiet: true });
      await runCommand(config.installCommand, { cwd: tempDir, quiet: true });
    });

    await runOptionalScripts('Running before scripts...', config.beforeScripts, tempDir, 'beforeScripts');
    await runOptionalScripts('Running after scripts...', config.afterScripts, tempDir, 'afterScripts');

    await runPhase('Preparing git changes...', 'Git changes prepared', async () => {
      branchName = await resolveBranchName(tempDir, branchPrefix, dateStamp);
      await createBranch(tempDir, branchName);
      await stageAll(tempDir);
    });

    if (!(await hasStagedChanges(tempDir))) {
      success('All dependencies are already up to date. Nothing to patch.');
      status = 'up_to_date';
      return true;
    }

    await runPhase('Committing and pushing branch...', 'PR branch pushed. Open your repo to create the pull request.', async () => {
      await commitChanges(tempDir, 'bridge: update dependencies (non-breaking)');
      await pushBranch(tempDir, branchName);
    });

    compareUrl = getCompareUrl(config.repoUrl, branchName);

    if (compareUrl) {
      line(compareUrl);
    }

    status = 'pushed';
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
          `Branch: ${branchName}`,
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
          `Branch: ${branchName}`,
          'All dependencies are already up to date.'
        ],
        'Bridge complete'
      );
    }
  }
}
