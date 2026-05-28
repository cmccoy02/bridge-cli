import { loadConfig } from '../core/configReader.js';
import {
  logRunEnd,
  logRunFailure,
  logRunStart,
  makeRunContext
} from '../core/activityLogger.js';
import { commandExists, runCommand } from '../core/executor.js';
import { getOriginUrl } from '../core/git.js';
import { error, line, success } from '../ui/logger.js';

function firstToken(commandString) {
  if (typeof commandString !== 'string' || commandString.trim().length === 0) {
    return '';
  }

  return commandString.trim().split(/\s+/)[0];
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function ensureBinary(commandString, contextLabel, issues) {
  const binary = firstToken(commandString);

  if (!binary) {
    return;
  }

  if (!(await commandExists(binary))) {
    issues.push(`${binary} is not available in PATH (${contextLabel})`);
  }
}

function commandList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

export async function validateCommand({ cwd = process.cwd(), offline = false } = {}) {
  const run = makeRunContext('validate', cwd);
  await logRunStart(run, { offline });

  let config;
  const issues = [];

  try {
    ({ config } = await loadConfig(cwd));
  } catch (configError) {
    issues.push(configError.message);
  }

  if (config) {
    const managerBinary = firstToken(config.packageManager);

    if (!(await commandExists('git'))) {
      issues.push('git is not available in PATH');
    }

    if (managerBinary && !(await commandExists(managerBinary))) {
      issues.push(`${managerBinary} is not available in PATH`);
    }

    await ensureBinary(config.installCommand, 'installCommand', issues);
    await ensureBinary(config.updateCommand, 'updateCommand', issues);

    for (const cleanCommand of commandList(config.cleanCommands)) {
      await ensureBinary(cleanCommand, 'cleanCommands', issues);
    }

    for (const beforeScript of commandList(config.beforeScripts)) {
      await ensureBinary(beforeScript, 'beforeScripts', issues);
    }

    for (const afterScript of commandList(config.afterScripts)) {
      await ensureBinary(afterScript, 'afterScripts', issues);
    }

    if (Array.isArray(config.scopes)) {
      for (const scope of config.scopes) {
        const scopeName = scope.path || '.';
        await ensureBinary(scope.installCommand, `scopes(${scopeName}).installCommand`, issues);
        await ensureBinary(scope.updateCommand, `scopes(${scopeName}).updateCommand`, issues);

        for (const scopeCleanCommand of commandList(scope.cleanCommands)) {
          await ensureBinary(scopeCleanCommand, `scopes(${scopeName}).cleanCommands`, issues);
        }

        for (const scopeBeforeScript of commandList(scope.beforeScripts)) {
          await ensureBinary(scopeBeforeScript, `scopes(${scopeName}).beforeScripts`, issues);
        }

        for (const scopeAfterScript of commandList(scope.afterScripts)) {
          await ensureBinary(scopeAfterScript, `scopes(${scopeName}).afterScripts`, issues);
        }
      }
    }

    if (!offline) {
      const originUrl = config.repoUrl || (await getOriginUrl(cwd));

      if (originUrl) {
        const probe = await runCommand(`git ls-remote ${quote(originUrl)} HEAD`, {
          allowFailure: true,
          quiet: true
        });

        if (!probe.success) {
          issues.push('Repository is not reachable. Check your origin remote and Git credentials.');
        }
      }
    }
  }

  if (issues.length > 0) {
    error('Validation failed.');

    for (const issue of issues) {
      line(`- ${issue}`);
    }

    await logRunFailure(run, new Error('Validation failed'), {
      issues
    });
    await logRunEnd(run, 'failed', { issuesCount: issues.length });
    return false;
  }

  success('Config is valid.');
  success('Required commands are available.');

  if (offline) {
    success('Skipped repo reachability check (--offline).');
  } else {
    success('Repository reachability check complete.');
  }

  await logRunEnd(run, 'passed', {
    offline
  });
  return true;
}
