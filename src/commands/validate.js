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
    const installBinary = firstToken(config.installCommand);
    const updateBinary = firstToken(config.updateCommand);

    if (!(await commandExists('git'))) {
      issues.push('git is not available in PATH');
    }

    if (managerBinary && !(await commandExists(managerBinary))) {
      issues.push(`${managerBinary} is not available in PATH`);
    }

    if (installBinary && !(await commandExists(installBinary))) {
      issues.push(`${installBinary} is not available in PATH (installCommand)`);
    }

    if (updateBinary && !(await commandExists(updateBinary))) {
      issues.push(`${updateBinary} is not available in PATH (updateCommand)`);
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
