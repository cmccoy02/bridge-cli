import fs from 'node:fs/promises';
import path from 'node:path';

import { runCommand } from './executor.js';

const DEPENDENCY_GROUPS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies'
];

async function findGitMetadata(rootDir) {
  const pending = [rootDir];

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.git') {
        return path.join(current, entry.name);
      }

      if (
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        entry.name !== 'dist'
      ) {
        pending.push(path.join(current, entry.name));
      }
    }
  }

  return '';
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function restoreDependencySpec(target, original, packageName) {
  for (const group of DEPENDENCY_GROUPS) {
    const originalGroup = original[group];
    const targetGroup = target[group];

    if (originalGroup && Object.prototype.hasOwnProperty.call(originalGroup, packageName)) {
      target[group] ||= {};
      target[group][packageName] = originalGroup[packageName];
    } else if (targetGroup) {
      delete targetGroup[packageName];
    }
  }
}

function removeLocalLockEntries(lock, originalLock, localPackage) {
  const packages = lock.packages || {};
  const originalPackages = originalLock.packages || {};
  const installedKey = `node_modules/${localPackage.name}`;

  for (const [key, entry] of Object.entries(packages)) {
    if (
      key !== installedKey &&
      (entry?.name === localPackage.name ||
        (entry?.link && String(entry.resolved || '').includes(localPackage.realPath)))
    ) {
      delete packages[key];
    }
  }

  for (const [key, entry] of Object.entries(originalPackages)) {
    if (key === installedKey || entry?.name === localPackage.name) {
      packages[key] = structuredClone(entry);
    }
  }

  if (!Object.prototype.hasOwnProperty.call(originalPackages, installedKey)) {
    delete packages[installedKey];
  }

  restoreDependencySpec(packages[''] || {}, originalPackages[''] || {}, localPackage.name);

  if (originalLock.dependencies?.[localPackage.name]) {
    lock.dependencies ||= {};
    lock.dependencies[localPackage.name] = structuredClone(
      originalLock.dependencies[localPackage.name]
    );
  } else if (lock.dependencies) {
    delete lock.dependencies[localPackage.name];
  }
}

export function parseLocalPackageArguments(values, sourceCwd) {
  const entries = Array.isArray(values) ? values : [];
  const seen = new Set();

  return entries.map((value) => {
    const raw = String(value || '').trim();
    const separator = raw.indexOf('=');
    const name = separator > 0 ? raw.slice(0, separator).trim() : '';
    const requestedPath = separator > 0 ? raw.slice(separator + 1).trim() : '';

    if (!name || !requestedPath) {
      throw new Error(
        `Invalid --local-package value "${raw}". Use package-name=/absolute/or/relative/path.`
      );
    }

    if (seen.has(name)) {
      throw new Error(`Duplicate --local-package entry for ${name}.`);
    }

    seen.add(name);
    return {
      name,
      path: path.resolve(sourceCwd, requestedPath)
    };
  });
}

export function addNpmInstallLinksFlag(command) {
  const value = String(command || '').trim();

  if (!value || value.includes('--install-links')) {
    return value;
  }

  if (!/^npm\s+(?:ci|install|i|update)\b/.test(value)) {
    throw new Error(
      `Local npm packages require an npm ci/install/update command, received: ${value || '(empty)'}.`
    );
  }

  return `${value} --install-links`;
}

export async function prepareNpmLocalPackages({
  cwd,
  localPackages,
  quiet = true
}) {
  if (!Array.isArray(localPackages) || localPackages.length === 0) {
    return null;
  }

  const manifestPath = path.join(cwd, 'package.json');
  const lockfilePath = path.join(cwd, 'package-lock.json');
  const originalManifestText = await fs.readFile(manifestPath, 'utf8');
  const originalLockfileText = await fs.readFile(lockfilePath, 'utf8');
  const manifest = JSON.parse(originalManifestText);
  const lock = JSON.parse(originalLockfileText);
  const resolvedPackages = [];

  for (const localPackage of localPackages) {
    const realPath = await fs.realpath(localPackage.path);
    const stat = await fs.stat(realPath);

    if (!stat.isDirectory()) {
      throw new Error(`Local package path is not a directory: ${localPackage.path}`);
    }

    const gitMetadataPath = await findGitMetadata(realPath);

    if (gitMetadataPath) {
      throw new Error(
        `Local package ${localPackage.name} contains Git metadata at ${gitMetadataPath}. Remove it before linking.`
      );
    }

    const localManifest = JSON.parse(
      await fs.readFile(path.join(realPath, 'package.json'), 'utf8')
    );

    if (localManifest.name !== localPackage.name) {
      throw new Error(
        `Local package name mismatch: expected ${localPackage.name}, found ${localManifest.name || '(missing)'}.`
      );
    }

    const dependencyGroup = DEPENDENCY_GROUPS.find((group) =>
      Object.prototype.hasOwnProperty.call(manifest[group] || {}, localPackage.name)
    );

    if (!dependencyGroup) {
      throw new Error(
        `Local package ${localPackage.name} is not declared in ${path.basename(manifestPath)}.`
      );
    }

    manifest[dependencyGroup][localPackage.name] = `file:${realPath}`;
    lock.packages ||= {};
    lock.packages[''] ||= {};
    lock.packages[''][dependencyGroup] ||= {};
    lock.packages[''][dependencyGroup][localPackage.name] = `file:${realPath}`;
    delete lock.packages[`node_modules/${localPackage.name}`];

    if (lock.dependencies) {
      delete lock.dependencies[localPackage.name];
    }

    resolvedPackages.push({
      ...localPackage,
      realPath,
      version: localManifest.version || ''
    });
  }

  await fs.writeFile(manifestPath, formatJson(manifest), 'utf8');
  await fs.writeFile(lockfilePath, formatJson(lock), 'utf8');
  await runCommand(
    'npm install --package-lock-only --ignore-scripts --install-links',
    {
    cwd,
    quiet
    }
  );

  return {
    manifestPath,
    lockfilePath,
    originalManifestText,
    originalLockfileText,
    localPackages: resolvedPackages
  };
}

export async function restoreNpmLocalPackages(snapshot, { cwd, quiet = true }) {
  if (!snapshot) {
    return;
  }

  const originalManifest = JSON.parse(snapshot.originalManifestText);
  const originalLock = JSON.parse(snapshot.originalLockfileText);
  const manifest = JSON.parse(await fs.readFile(snapshot.manifestPath, 'utf8'));
  const lock = JSON.parse(await fs.readFile(snapshot.lockfilePath, 'utf8'));

  for (const localPackage of snapshot.localPackages) {
    restoreDependencySpec(manifest, originalManifest, localPackage.name);
    removeLocalLockEntries(lock, originalLock, localPackage);
  }

  await fs.writeFile(snapshot.manifestPath, formatJson(manifest), 'utf8');
  await fs.writeFile(snapshot.lockfilePath, formatJson(lock), 'utf8');

  await runCommand('npm install --package-lock-only --ignore-scripts --offline', {
    cwd,
    quiet
  });

  const normalizedManifest = JSON.parse(
    await fs.readFile(snapshot.manifestPath, 'utf8')
  );
  const normalizedLock = JSON.parse(await fs.readFile(snapshot.lockfilePath, 'utf8'));

  for (const localPackage of snapshot.localPackages) {
    restoreDependencySpec(normalizedManifest, originalManifest, localPackage.name);
    removeLocalLockEntries(normalizedLock, originalLock, localPackage);
  }

  const finalManifestText = formatJson(normalizedManifest);
  const finalLockfileText = formatJson(normalizedLock);

  for (const localPackage of snapshot.localPackages) {
    if (
      finalManifestText.includes(localPackage.realPath) ||
      finalLockfileText.includes(localPackage.realPath)
    ) {
      throw new Error(
        `Local package path leaked into candidate files for ${localPackage.name}.`
      );
    }
  }

  await fs.writeFile(snapshot.manifestPath, finalManifestText, 'utf8');
  await fs.writeFile(snapshot.lockfilePath, finalLockfileText, 'utf8');
}
