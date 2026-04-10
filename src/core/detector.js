import fs from 'node:fs/promises';
import path from 'node:path';

import { PACKAGE_MANAGER_PRESETS } from '../constants.js';

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function detectPackageManagerByFiles(flags) {
  if (flags.hasPackageLock) {
    return 'npm';
  }

  if (flags.hasYarnLock) {
    return 'yarn';
  }

  if (flags.hasPnpmLock) {
    return 'pnpm';
  }

  if (flags.hasRequirements) {
    return 'pip';
  }

  if (flags.hasMixExs) {
    return 'mix';
  }

  return null;
}

async function readOriginUrl(cwd) {
  const gitConfigPath = path.join(cwd, '.git', 'config');

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
  const flags = {
    hasPackageLock: await fileExists(path.join(cwd, 'package-lock.json')),
    hasYarnLock: await fileExists(path.join(cwd, 'yarn.lock')),
    hasPnpmLock: await fileExists(path.join(cwd, 'pnpm-lock.yaml')),
    hasRequirements: await fileExists(path.join(cwd, 'requirements.txt')),
    hasMixExs: await fileExists(path.join(cwd, 'mix.exs'))
  };

  const packageManager = detectPackageManagerByFiles(flags);
  const repoUrl = await readOriginUrl(cwd);
  const name = await readPackageName(cwd);

  const detectedMessage = packageManager
    ? `We detected a ${PACKAGE_MANAGER_PRESETS[packageManager].label}.`
    : 'We could not auto-detect a package manager, so you can choose one.';

  return {
    packageManager,
    repoUrl,
    name,
    detectedMessage
  };
}
