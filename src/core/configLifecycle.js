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

export async function cleanupLocalConfigAfterSuccessfulPush(
  cwd,
  configFileName = CONFIG_FILE_NAME,
  { onWarning } = {}
) {
  try {
    const configPath = path.join(cwd, configFileName);

    if (!(await fileExists(configPath))) {
      return {
        removed: false,
        reason: 'missing'
      };
    }

    if (await isPathTrackedOrInHistory(cwd, configFileName)) {
      return {
        removed: false,
        reason: 'tracked_or_history'
      };
    }

    await fs.rm(configPath, { force: true });
    return {
      removed: true,
      reason: 'untracked_first_init'
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
