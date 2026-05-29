import fs from 'node:fs/promises';
import path from 'node:path';

import prompts from 'prompts';

import {
  CONFIG_FILE_NAME,
  DEFAULT_BRANCH_PREFIX,
  PACKAGE_MANAGER_OPTIONS,
  PACKAGE_MANAGER_PRESETS
} from '../constants.js';
import {
  logRunEnd,
  logRunFailure,
  logRunStart,
  makeRunContext
} from '../core/activityLogger.js';
import { detectProject } from '../core/detector.js';
import { formatConfig } from '../core/configReader.js';
import { printBanner } from '../ui/banner.js';
import { info, line, success, warn } from '../ui/logger.js';

function parseCommandList(raw, fallback = []) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [...fallback];
  }

  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function managerPromptIndex(defaultManager) {
  const index = PACKAGE_MANAGER_OPTIONS.indexOf(defaultManager);
  return index >= 0 ? index : 0;
}

export async function initCommand({ cwd = process.cwd() } = {}) {
  const run = makeRunContext('init', cwd);

  try {
    await logRunStart(run);
    printBanner();

    const detected = await detectProject(cwd);
    const detectedManager = detected.packageManager || null;

    info(detected.detectedMessage);
    line();

    if (detected.unsupported) {
      warn('Initialization stopped: unsupported dependency layout for safe patching.');
      await logRunEnd(run, 'unsupported', {
        unsupported: detected.unsupported
      });
      return false;
    }

    const basePrompts = [
      {
        type: 'text',
        name: 'name',
        message: 'Project name',
        initial: detected.name || ''
      }
    ];

    if (!detectedManager) {
      basePrompts.push({
        type: 'select',
        name: 'packageManager',
        message: 'Package manager',
        choices: PACKAGE_MANAGER_OPTIONS.map((value) => ({
          title: value,
          value
        })),
        initial: managerPromptIndex('npm')
      });
    }

    const baseResponses = await prompts(basePrompts, {
      onCancel: () => {
        throw new Error('Initialization canceled.');
      }
    });

    const packageManager = detectedManager || baseResponses.packageManager || 'npm';
    const managerPreset = PACKAGE_MANAGER_PRESETS[packageManager] || PACKAGE_MANAGER_PRESETS.npm;

    const detailResponses = await prompts(
      [
        {
          type: 'text',
          name: 'installCommand',
          message: 'Install command',
          initial: managerPreset.installCommand
        },
        {
          type: 'text',
          name: 'updateCommand',
          message: 'Update command',
          initial: managerPreset.updateCommand
        },
        {
          type: 'text',
          name: 'cleanCommands',
          message: 'Clean commands (comma or newline separated)',
          initial: managerPreset.cleanCommands.join(', ')
        },
        {
          type: 'text',
          name: 'beforeScripts',
          message: 'Before scripts (optional, comma or newline separated)',
          initial: ''
        },
        {
          type: 'text',
          name: 'afterScripts',
          message: 'After scripts (optional, comma or newline separated)',
          initial: ''
        },
        {
          type: 'text',
          name: 'branchPrefix',
          message: 'Branch prefix',
          initial: DEFAULT_BRANCH_PREFIX
        }
      ],
      {
        onCancel: () => {
          throw new Error('Initialization canceled.');
        }
      }
    );

    const config = {
      name: (baseResponses.name || '').trim(),
      packageManager,
      installCommand: (detailResponses.installCommand || '').trim(),
      updateCommand: (detailResponses.updateCommand || '').trim(),
      cleanCommands: parseCommandList(detailResponses.cleanCommands, managerPreset.cleanCommands),
      beforeScripts: parseCommandList(detailResponses.beforeScripts, []),
      afterScripts: parseCommandList(detailResponses.afterScripts, []),
      branchPrefix: (detailResponses.branchPrefix || DEFAULT_BRANCH_PREFIX).trim()
    };

    const detectedRepoUrl = (detected.repoUrl || '').trim();

    if (detectedRepoUrl) {
      config.repoUrl = detectedRepoUrl;
    }

    line('Config preview:');
    line(formatConfig(config));
    line();

    const { confirmWrite } = await prompts(
      {
        type: 'toggle',
        name: 'confirmWrite',
        message: `Write ${CONFIG_FILE_NAME}?`,
        initial: true,
        active: 'yes',
        inactive: 'no'
      },
      {
        onCancel: () => {
          throw new Error('Initialization canceled.');
        }
      }
    );

    if (!confirmWrite) {
      warn('Initialization canceled.');
      await logRunEnd(run, 'canceled');
      return false;
    }

    const configPath = path.join(cwd, CONFIG_FILE_NAME);
    await fs.writeFile(configPath, `${formatConfig(config)}\n`, 'utf8');

    success(`Created ${CONFIG_FILE_NAME}`);
    line();
    info('Run `bridge patch` to create your first update PR.');
    await logRunEnd(run, 'created', {
      packageManager: config.packageManager,
      hasRepoUrl: Boolean(config.repoUrl)
    });

    return true;
  } catch (error) {
    if (error.message === 'Initialization canceled.') {
      warn(error.message);
      await logRunEnd(run, 'canceled');
      return false;
    }

    await logRunFailure(run, error);
    await logRunEnd(run, 'failed');
    throw error;
  }
}
