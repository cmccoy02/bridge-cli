import fs from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_FILE_NAME } from '../constants.js';
import { isPathTrackedOrInHistory } from './git.js';

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
