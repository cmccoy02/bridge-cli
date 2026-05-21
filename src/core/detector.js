import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { PACKAGE_MANAGER_PRESETS } from '../constants.js';

const execFileAsync = promisify(execFile);

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageLock(cwd) {
  const filePath = path.join(cwd, 'package-lock.json');

  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);

    if (parsed && typeof parsed === 'object' && parsed.lockfileVersion) {
      return 'npm';
    }
  } catch {
    return null;
  }

  return null;
}

async function readYarnLock(cwd) {
  const filePath = path.join(cwd, 'yarn.lock');

  try {
    const content = await fs.readFile(filePath, 'utf8');
    const trimmed = content.trim();

    if (
      trimmed.includes('yarn lockfile') ||
      trimmed.includes('__metadata:') ||
      trimmed.length > 0
    ) {
      return 'yarn';
    }
  } catch {
    return null;
  }

  return null;
}

async function readPnpmLock(cwd) {
  const filePath = path.join(cwd, 'pnpm-lock.yaml');

  try {
    const content = await fs.readFile(filePath, 'utf8');

    if (/lockfileVersion:/m.test(content)) {
      return 'pnpm';
    }
  } catch {
    return null;
  }

  return null;
}

async function detectPackageManagerByLockfiles(cwd) {
  const matches = new Set();
  const lockDetections = await Promise.all([
    readPackageLock(cwd),
    readYarnLock(cwd),
    readPnpmLock(cwd)
  ]);

  for (const candidate of lockDetections) {
    if (candidate) {
      matches.add(candidate);
    }
  }

  if (matches.size === 1) {
    return [...matches][0];
  }

  return null;
}

async function readGitOriginFromCommand(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function resolveGitDirectory(cwd) {
  const dotGitPath = path.join(cwd, '.git');

  try {
    const stat = await fs.stat(dotGitPath);

    if (stat.isDirectory()) {
      return dotGitPath;
    }

    if (stat.isFile()) {
      const content = await fs.readFile(dotGitPath, 'utf8');
      const match = content.match(/gitdir:\s*(.+)/i);

      if (match && match[1]) {
        return path.resolve(cwd, match[1].trim());
      }
    }
  } catch {
    return '';
  }

  return '';
}

async function readOriginUrlFromGitConfig(cwd) {
  const gitDir = await resolveGitDirectory(cwd);

  if (!gitDir) {
    return '';
  }

  const gitConfigPath = path.join(gitDir, 'config');

  try {
    const content = await fs.readFile(gitConfigPath, 'utf8');
    const originBlock = content.match(/\[remote\s+"origin"\][\s\S]*?(?=\n\[|$)/m);

    if (!originBlock) {
      return '';
    }

    const urlLine = originBlock[0]
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('url ='));

    if (!urlLine) {
      return '';
    }

    return urlLine.replace('url =', '').trim();
  } catch {
    return '';
  }
}

async function readOriginUrl(cwd) {
  const fromCommand = await readGitOriginFromCommand(cwd);

  if (fromCommand) {
    return fromCommand;
  }

  return readOriginUrlFromGitConfig(cwd);
}

function deriveNameFromRepoUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== 'string') {
    return '';
  }

  const normalized = repoUrl.trim().replace(/\.git$/, '').replace(/\/$/, '');

  if (!normalized) {
    return '';
  }

  const parts = normalized.split(/[/:]/).filter(Boolean);
  return parts.at(-1) || '';
}

async function readGitConfigValue(cwd, key) {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', key], { cwd });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function readPackageName(cwd) {
  const packageJsonPath = path.join(cwd, 'package.json');

  try {
    const content = await fs.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(content);
    return typeof parsed.name === 'string' ? parsed.name : '';
  } catch {
    return '';
  }
}

export async function detectProject(cwd = process.cwd()) {
  const packageManager = await detectPackageManagerByLockfiles(cwd);
  const repoUrl = await readOriginUrl(cwd);
  const packageName = await readPackageName(cwd);
  const gitConfiguredRepoUrl = await readGitConfigValue(cwd, 'remote.origin.url');
  const fallbackRepoUrl = repoUrl || gitConfiguredRepoUrl;
  const derivedNameFromRemote = deriveNameFromRepoUrl(fallbackRepoUrl);
  const directoryName = path.basename(cwd);
  const name = packageName || derivedNameFromRemote || directoryName;
  const hasRequirements = await fileExists(path.join(cwd, 'requirements.txt'));
  const hasMixExs = await fileExists(path.join(cwd, 'mix.exs'));

  const fallbackManager = hasRequirements ? 'pip' : hasMixExs ? 'mix' : null;
  const resolvedPackageManager = packageManager || fallbackManager;

  const detectedMessage = resolvedPackageManager
    ? `We detected a ${PACKAGE_MANAGER_PRESETS[resolvedPackageManager].label}.`
    : 'We could not auto-detect a package manager, so you can choose one.';

  return {
    packageManager: resolvedPackageManager,
    repoUrl: fallbackRepoUrl,
    name,
    detectedMessage
  };
}
