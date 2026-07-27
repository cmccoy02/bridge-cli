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

function normalizeBundleAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return {
    command: typeof value.command === 'string' ? value.command.trim() : '',
    reportPath: typeof value.reportPath === 'string' ? value.reportPath.trim() : '',
    metric: ['rendered', 'gzip', 'brotli'].includes(value.metric)
      ? value.metric
      : 'brotli',
    maxIncreasePercent:
      typeof value.maxIncreasePercent === 'number' ? value.maxIncreasePercent : 5,
    maxIncreaseBytes:
      typeof value.maxIncreaseBytes === 'number' ? value.maxIncreaseBytes : null
  };
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
    afterScripts: normalizeArray(scope.afterScripts),
    auditCommand:
      typeof scope.auditCommand === 'string' ? scope.auditCommand.trim() : '',
    blockOnNewVulnerabilities:
      typeof scope.blockOnNewVulnerabilities === 'boolean'
        ? scope.blockOnNewVulnerabilities
        : undefined,
    allowMajorUpdates:
      typeof scope.allowMajorUpdates === 'boolean' ? scope.allowMajorUpdates : undefined,
    bundleAnalysis: normalizeBundleAnalysis(scope.bundleAnalysis),
    pythonZeroMajor: ['minor', 'patch', 'skip'].includes(scope.pythonZeroMajor)
      ? scope.pythonZeroMajor
      : undefined
  };
}

function isSafeScopePath(scopePath) {
  if (isBlankString(scopePath) || path.isAbsolute(scopePath)) {
    return false;
  }

  const normalized = path.normalize(scopePath.trim());
  return (
    normalized !== '..' &&
    !normalized.startsWith(`..${path.sep}`) &&
    normalized !== path.sep
  );
}

function findMissingFields(config) {
  const missing = [];

  for (const field of REQUIRED_CONFIG_FIELDS) {
    if (!(field in config)) {
      missing.push(field);
      continue;
    }

    if (field === 'cleanCommands') {
      if (!Array.isArray(config.cleanCommands)) {
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

function validateBundleAnalysis(value, label, issues) {
  if (value === undefined || value === null) {
    return;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${label} must be an object`);
    return;
  }

  if (isBlankString(value.command)) {
    issues.push(`${label}.command is required`);
  }

  if (!isSafeScopePath(value.reportPath)) {
    issues.push(`${label}.reportPath must be a relative path inside the scope`);
  }

  if (
    'metric' in value &&
    !['rendered', 'gzip', 'brotli'].includes(value.metric)
  ) {
    issues.push(`${label}.metric must be "rendered", "gzip", or "brotli"`);
  }

  for (const threshold of ['maxIncreasePercent', 'maxIncreaseBytes']) {
    if (
      threshold in value &&
      (typeof value[threshold] !== 'number' ||
        !Number.isFinite(value[threshold]) ||
        value[threshold] < 0)
    ) {
      issues.push(`${label}.${threshold} must be a non-negative number`);
    }
  }
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

  if ('auditCommand' in config && typeof config.auditCommand !== 'string') {
    issues.push('auditCommand must be a shell command string');
  }

  if (
    'blockOnNewVulnerabilities' in config &&
    typeof config.blockOnNewVulnerabilities !== 'boolean'
  ) {
    issues.push('blockOnNewVulnerabilities must be true or false');
  }

  if ('allowMajorUpdates' in config && typeof config.allowMajorUpdates !== 'boolean') {
    issues.push('allowMajorUpdates must be true or false');
  }

  validateBundleAnalysis(config.bundleAnalysis, 'bundleAnalysis', issues);

  if ('protectedBranches' in config && !Array.isArray(config.protectedBranches)) {
    issues.push('protectedBranches must be an array of branch names');
  }

  if ('defaultBranch' in config && typeof config.defaultBranch !== 'string') {
    issues.push('defaultBranch must be a branch name string');
  }

  if (
    'pythonZeroMajor' in config &&
    !['minor', 'patch', 'skip'].includes(config.pythonZeroMajor)
  ) {
    issues.push('pythonZeroMajor must be one of "minor", "patch", or "skip"');
  }

  if ('scopes' in config) {
    if (!Array.isArray(config.scopes)) {
      issues.push('scopes must be an array');
    } else {
      const normalizedPaths = new Set();

      config.scopes.forEach((scope, index) => {
        if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
          issues.push(`scopes[${index}] must be an object`);
          return;
        }

        if (!isSafeScopePath(scope.path)) {
          issues.push(
            `scopes[${index}].path must be a relative path inside the repository`
          );
        } else {
          const normalizedPath = path.normalize(scope.path.trim());

          if (normalizedPath === '.') {
            issues.push(`scopes[${index}].path cannot duplicate the root scope`);
          } else if (normalizedPaths.has(normalizedPath)) {
            issues.push(`scopes[${index}].path duplicates another scope`);
          }

          normalizedPaths.add(normalizedPath);
        }

        if (isBlankString(scope.installCommand)) {
          issues.push(`scopes[${index}].installCommand is required`);
        }

        if (isBlankString(scope.updateCommand)) {
          issues.push(`scopes[${index}].updateCommand is required`);
        }

        if (!Array.isArray(scope.cleanCommands)) {
          issues.push(`scopes[${index}].cleanCommands must be an array`);
        }

        if ('beforeScripts' in scope && !Array.isArray(scope.beforeScripts)) {
          issues.push(`scopes[${index}].beforeScripts must be an array`);
        }

        if ('afterScripts' in scope && !Array.isArray(scope.afterScripts)) {
          issues.push(`scopes[${index}].afterScripts must be an array`);
        }

        if ('auditCommand' in scope && typeof scope.auditCommand !== 'string') {
          issues.push(`scopes[${index}].auditCommand must be a string`);
        }

        if (
          'blockOnNewVulnerabilities' in scope &&
          typeof scope.blockOnNewVulnerabilities !== 'boolean'
        ) {
          issues.push(
            `scopes[${index}].blockOnNewVulnerabilities must be true or false`
          );
        }

        if (
          'allowMajorUpdates' in scope &&
          typeof scope.allowMajorUpdates !== 'boolean'
        ) {
          issues.push(`scopes[${index}].allowMajorUpdates must be true or false`);
        }

        validateBundleAnalysis(
          scope.bundleAnalysis,
          `scopes[${index}].bundleAnalysis`,
          issues
        );

        if (
          'pythonZeroMajor' in scope &&
          !['minor', 'patch', 'skip'].includes(scope.pythonZeroMajor)
        ) {
          issues.push(
            `scopes[${index}].pythonZeroMajor must be one of "minor", "patch", or "skip"`
          );
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
    auditCommand:
      typeof config.auditCommand === 'string' ? config.auditCommand.trim() : '',
    blockOnNewVulnerabilities:
      typeof config.blockOnNewVulnerabilities === 'boolean'
        ? config.blockOnNewVulnerabilities
        : true,
    allowMajorUpdates:
      typeof config.allowMajorUpdates === 'boolean' ? config.allowMajorUpdates : false,
    bundleAnalysis: normalizeBundleAnalysis(config.bundleAnalysis),
    scopes,
    branchPrefix:
      typeof config.branchPrefix === 'string' && config.branchPrefix.trim()
        ? config.branchPrefix.trim()
        : DEFAULT_BRANCH_PREFIX,
    defaultBranch:
      typeof config.defaultBranch === 'string' ? config.defaultBranch.trim() : '',
    protectedBranches: normalizeArray(config.protectedBranches),
    // 0.x handling is deferred: skip pre-1.0 pins by default so Bridge never opens
    // a `0.*` wildcard. `minor`/`patch` stay selectable for when 0.x lands.
    pythonZeroMajor: ['minor', 'patch', 'skip'].includes(config.pythonZeroMajor)
      ? config.pythonZeroMajor
      : 'skip'
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
