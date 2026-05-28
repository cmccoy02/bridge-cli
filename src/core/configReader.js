import fs from 'node:fs/promises';
import path from 'node:path';

import {
  CONFIG_FILE_NAME,
  DEFAULT_BRANCH_PREFIX,
  REQUIRED_CONFIG_FIELDS
} from '../constants.js';

const CONFIG_CANDIDATES = [CONFIG_FILE_NAME, '.bridge.config.json'];

export class ConfigError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function isBlankString(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

function normalizeArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return null;
  }

  return {
    path: typeof scope.path === 'string' ? scope.path.trim() : '',
    packageManager:
      typeof scope.packageManager === 'string' ? scope.packageManager.trim() : '',
    installCommand:
      typeof scope.installCommand === 'string' ? scope.installCommand.trim() : '',
    updateCommand:
      typeof scope.updateCommand === 'string' ? scope.updateCommand.trim() : '',
    cleanCommands: normalizeArray(scope.cleanCommands),
    beforeScripts: normalizeArray(scope.beforeScripts),
    afterScripts: normalizeArray(scope.afterScripts)
  };
}

function findMissingFields(config) {
  const missing = [];

  for (const field of REQUIRED_CONFIG_FIELDS) {
    if (!(field in config)) {
      missing.push(field);
      continue;
    }

    if (field === 'cleanCommands') {
      if (!Array.isArray(config.cleanCommands) || config.cleanCommands.length === 0) {
        missing.push(field);
      }

      continue;
    }

    if (isBlankString(config[field])) {
      missing.push(field);
    }
  }

  return missing;
}

function findShapeIssues(config) {
  const issues = [];

  if ('cleanCommands' in config && !Array.isArray(config.cleanCommands)) {
    issues.push('cleanCommands must be an array of shell commands');
  }

  if ('beforeScripts' in config && !Array.isArray(config.beforeScripts)) {
    issues.push('beforeScripts must be an array of shell commands');
  }

  if ('afterScripts' in config && !Array.isArray(config.afterScripts)) {
    issues.push('afterScripts must be an array of shell commands');
  }

  if ('scopes' in config) {
    if (!Array.isArray(config.scopes)) {
      issues.push('scopes must be an array');
    } else {
      config.scopes.forEach((scope, index) => {
        if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
          issues.push(`scopes[${index}] must be an object`);
          return;
        }

        if (isBlankString(scope.path)) {
          issues.push(`scopes[${index}].path is required`);
        }

        if (isBlankString(scope.installCommand)) {
          issues.push(`scopes[${index}].installCommand is required`);
        }

        if (isBlankString(scope.updateCommand)) {
          issues.push(`scopes[${index}].updateCommand is required`);
        }

        if (!Array.isArray(scope.cleanCommands) || scope.cleanCommands.length === 0) {
          issues.push(`scopes[${index}].cleanCommands must be a non-empty array`);
        }
      });
    }
  }

  return issues;
}

export function normalizeConfig(config) {
  const scopes = Array.isArray(config.scopes)
    ? config.scopes.map((scope) => normalizeScope(scope)).filter(Boolean)
    : [];

  return {
    ...config,
    name: typeof config.name === 'string' ? config.name.trim() : '',
    repoUrl: typeof config.repoUrl === 'string' ? config.repoUrl.trim() : '',
    packageManager:
      typeof config.packageManager === 'string' ? config.packageManager.trim() : '',
    installCommand:
      typeof config.installCommand === 'string' ? config.installCommand.trim() : '',
    updateCommand:
      typeof config.updateCommand === 'string' ? config.updateCommand.trim() : '',
    cleanCommands: normalizeArray(config.cleanCommands),
    beforeScripts: normalizeArray(config.beforeScripts),
    afterScripts: normalizeArray(config.afterScripts),
    scopes,
    branchPrefix:
      typeof config.branchPrefix === 'string' && config.branchPrefix.trim()
        ? config.branchPrefix.trim()
        : DEFAULT_BRANCH_PREFIX
  };
}

export async function readConfigFile(cwd = process.cwd()) {
  let configPath = '';
  let raw = '';
  let lastError = null;

  for (const candidate of CONFIG_CANDIDATES) {
    const candidatePath = path.join(cwd, candidate);

    try {
      raw = await fs.readFile(candidatePath, 'utf8');
      configPath = candidatePath;
      break;
    } catch (error) {
      lastError = error;

      if (!error || error.code !== 'ENOENT') {
        throw new ConfigError(`Could not read ${candidate}: ${error.message}`);
      }
    }
  }

  if (!configPath) {
    if (lastError && lastError.code !== 'ENOENT') {
      throw new ConfigError(`Could not read config file: ${lastError.message}`);
    }

    throw new ConfigError(
      'No bridge.config.json or .bridge.config.json found. Run `bridge init` first.'
    );
  }

  try {
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Config root must be a JSON object');
    }

    return {
      configPath,
      config: parsed
    };
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${CONFIG_FILE_NAME}: ${error.message}`);
  }
}

export async function loadConfig(cwd = process.cwd()) {
  const { configPath, config } = await readConfigFile(cwd);
  const missingFields = findMissingFields(config);
  const shapeIssues = findShapeIssues(config);

  if (missingFields.length > 0 || shapeIssues.length > 0) {
    const issues = [];

    if (missingFields.length > 0) {
      issues.push(`Missing required fields: ${missingFields.join(', ')}`);
    }

    issues.push(...shapeIssues);

    throw new ConfigError(issues.join('. '), issues);
  }

  return {
    configPath,
    config: normalizeConfig(config)
  };
}

export function formatConfig(config) {
  return JSON.stringify(config, null, 2);
}
