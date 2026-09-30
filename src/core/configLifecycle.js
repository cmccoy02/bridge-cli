import fs from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_CANDIDATES, CONFIG_FILE_NAME } from '../constants.js';
import { isPathTracked, isPathTrackedOrInHistory } from './git.js';

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const CONFIG_RETENTION_POLICIES = ['keep', 'delete'];
export const DEFAULT_CONFIG_RETENTION_POLICY = 'keep';

export async function cleanupLocalConfigAfterSuccessfulPush(
  cwd,
  configFileName = CONFIG_FILE_NAME,
  { onWarning, retentionPolicy = DEFAULT_CONFIG_RETENTION_POLICY } = {}
) {
  try {
    const configPath = path.join(cwd, configFileName);
    const normalizedPolicy = CONFIG_RETENTION_POLICIES.includes(retentionPolicy)
      ? retentionPolicy
      : DEFAULT_CONFIG_RETENTION_POLICY;

    if (!(await fileExists(configPath))) {
      return {
        removed: false,
        reason: 'missing',
        policy: normalizedPolicy
      };
    }

    if (await isPathTrackedOrInHistory(cwd, configFileName)) {
      return {
        removed: false,
        reason: 'tracked_or_history',
        policy: normalizedPolicy
      };
    }

    if (normalizedPolicy === 'keep') {
      return {
        removed: false,
        reason: 'policy_keep',
        policy: normalizedPolicy
      };
    }

    await fs.rm(configPath, { force: true });
    return {
      removed: true,
      reason: 'untracked_first_init',
      policy: normalizedPolicy
    };
  } catch (cleanupError) {
    if (typeof onWarning === 'function') {
      onWarning(cleanupError);
    }

    return {
      removed: false,
      reason: 'warning',
      error: cleanupError
    };
  }
}

export async function isolateUntrackedBridgeConfig({
  workspaceDir,
  sourceConfigPath = '',
  configFileNames = CONFIG_CANDIDATES
} = {}) {
  const hiddenDir = path.join(workspaceDir, '.git', 'bridge');
  const results = [];

  await fs.mkdir(hiddenDir, { recursive: true });

  for (const configFileName of configFileNames) {
    const workspaceConfigPath = path.join(workspaceDir, configFileName);
    const hiddenPath = path.join(hiddenDir, configFileName);
    const tracked = await isPathTracked(workspaceDir, configFileName);

    if (tracked) {
      results.push({
        fileName: configFileName,
        isolated: false,
        reason: 'tracked',
        path: workspaceConfigPath
      });
      continue;
    }

    if (await fileExists(workspaceConfigPath)) {
      await fs.rename(workspaceConfigPath, hiddenPath);
      results.push({
        fileName: configFileName,
        isolated: true,
        reason: 'moved',
        path: hiddenPath
      });
      continue;
    }

    const sourceName = sourceConfigPath ? path.basename(sourceConfigPath) : '';
    if (sourceConfigPath && sourceName === configFileName && (await fileExists(sourceConfigPath))) {
      await fs.copyFile(sourceConfigPath, hiddenPath);
      results.push({
        fileName: configFileName,
        isolated: true,
        reason: 'copied_hidden',
        path: hiddenPath
      });
      continue;
    }

    results.push({
      fileName: configFileName,
      isolated: false,
      reason: 'missing',
      path: ''
    });
  }

  return {
    hiddenDir,
    isolated: results.some((entry) => entry.isolated),
    results
  };
}
