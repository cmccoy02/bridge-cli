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

async function readTextFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
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

async function detectJsPackageManagerByLockfiles(cwd) {
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

  const managers = [...matches];

  if (managers.length === 1) {
    return { manager: managers[0], managers };
  }

  return { manager: null, managers };
}

function hasPoetryTable(pyprojectContent) {
  return /^\s*\[tool\.poetry(?:\]|\.)/m.test(pyprojectContent);
}

function hasProjectTable(pyprojectContent) {
  return /^\s*\[project\]\s*$/m.test(pyprojectContent);
}

async function detectPythonManager(cwd) {
  const hasUvLock = await fileExists(path.join(cwd, 'uv.lock'));

  if (hasUvLock) {
    return {
      manager: 'uv',
      source: 'python_lockfile',
      unsupported: '',
      detectedMessage: `We detected a ${PACKAGE_MANAGER_PRESETS.uv.label} from lockfiles.`
    };
  }

  const pyprojectPath = path.join(cwd, 'pyproject.toml');
  const pyprojectContent = await readTextFileIfExists(pyprojectPath);
  const hasPoetryLock = await fileExists(path.join(cwd, 'poetry.lock'));

  if (hasPoetryLock || hasPoetryTable(pyprojectContent)) {
    return {
      manager: 'poetry',
      source: hasPoetryLock ? 'python_lockfile' : 'python_manifest',
      unsupported: '',
      detectedMessage: `We detected a ${PACKAGE_MANAGER_PRESETS.poetry.label} from project files.`
    };
  }

  if (await fileExists(path.join(cwd, 'Pipfile'))) {
    return {
      manager: 'pipenv',
      source: 'python_manifest',
      unsupported: '',
      detectedMessage: `We detected a ${PACKAGE_MANAGER_PRESETS.pipenv.label} from project files.`
    };
  }

  if (await fileExists(path.join(cwd, 'requirements.in'))) {
    return {
      manager: 'pip-compile',
      source: 'python_manifest',
      unsupported: '',
      detectedMessage: `We detected a ${PACKAGE_MANAGER_PRESETS['pip-compile'].label} from project files.`
    };
  }

  if (await fileExists(path.join(cwd, 'requirements.txt'))) {
    return {
      manager: null,
      source: 'unsupported',
      unsupported: 'bare-requirements',
      detectedMessage:
        "Bridge detected a bare requirements.txt project. Bridge can't safely patch bare requirements.txt yet. Add requirements.in + pip-compile (or use poetry/pipenv/uv) and run bridge init again."
    };
  }

  if (pyprojectContent && hasProjectTable(pyprojectContent)) {
    return {
      manager: null,
      source: 'unsupported',
      unsupported: 'pep621-no-lock',
      detectedMessage:
        'Bridge detected a PEP 621 pyproject.toml project without a supported lockfile manager (uv/poetry). Add uv.lock or poetry.lock and run bridge init again.'
    };
  }

  return {
    manager: null,
    source: '',
    unsupported: '',
    detectedMessage: ''
  };
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

async function readPackageManagerFromPackageJson(cwd) {
  const packageJsonPath = path.join(cwd, 'package.json');

  try {
    const content = await fs.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(content);
    const raw = typeof parsed.packageManager === 'string' ? parsed.packageManager.trim() : '';

    if (!raw) {
      return '';
    }

    const manager = raw.split('@')[0].trim();
    return PACKAGE_MANAGER_PRESETS[manager] ? manager : '';
  } catch {
    return '';
  }
}

export async function detectProject(cwd = process.cwd()) {
  const packageJsonManager = await readPackageManagerFromPackageJson(cwd);
  const jsLockfileDetection = await detectJsPackageManagerByLockfiles(cwd);
  const pythonDetection = await detectPythonManager(cwd);
  const lockfileManager = jsLockfileDetection.manager;
  const lockfileManagers = jsLockfileDetection.managers;
  const repoUrl = await readOriginUrl(cwd);
  const packageName = await readPackageName(cwd);
  const gitConfiguredRepoUrl = await readGitConfigValue(cwd, 'remote.origin.url');
  const fallbackRepoUrl = repoUrl || gitConfiguredRepoUrl;
  const derivedNameFromRemote = deriveNameFromRepoUrl(fallbackRepoUrl);
  const directoryName = path.basename(cwd);
  const name = packageName || derivedNameFromRemote || directoryName;
  const hasMixExs = await fileExists(path.join(cwd, 'mix.exs'));
  const hasMultipleJsLockfiles = lockfileManagers.length > 1;
  const fallbackManager = hasMixExs ? 'mix' : null;
  const resolvedPackageManager =
    packageJsonManager ||
    (hasMultipleJsLockfiles
      ? null
      : lockfileManager || pythonDetection.manager || fallbackManager);
  const unsupported = !resolvedPackageManager ? pythonDetection.unsupported : '';
  const detectionSource = packageJsonManager
    ? 'package.json#packageManager'
    : lockfileManager
      ? 'lockfile'
      : pythonDetection.manager
        ? pythonDetection.source
        : fallbackManager
          ? 'language_fallback'
          : unsupported
            ? 'unsupported'
            : '';

  let detectedMessage = 'We could not auto-detect a package manager, so you can choose one.';

  if (resolvedPackageManager) {
    const sourceDetail =
      detectionSource === 'package.json#packageManager'
        ? 'from package.json packageManager'
        : detectionSource === 'lockfile'
          ? 'from lockfiles'
          : detectionSource === 'python_lockfile'
            ? 'from Python lockfiles'
            : detectionSource === 'python_manifest'
              ? 'from Python project files'
              : 'from project files';

    detectedMessage = `We detected a ${PACKAGE_MANAGER_PRESETS[resolvedPackageManager].label} ${sourceDetail}.`;
  } else if (hasMultipleJsLockfiles) {
    detectedMessage = `We found multiple lockfiles (${lockfileManagers.join(', ')}), so choose the package manager to use.`;
  } else if (unsupported && pythonDetection.detectedMessage) {
    detectedMessage = pythonDetection.detectedMessage;
  }

  return {
    packageManager: resolvedPackageManager,
    repoUrl: fallbackRepoUrl,
    name,
    detectedMessage,
    detectionSource,
    detectedLockfileManagers: lockfileManagers,
    unsupported
  };
}
