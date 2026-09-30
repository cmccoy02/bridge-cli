import { runCommand } from './executor.js';
import os from 'node:os';

const versionCache = new Map();

export async function getCommandVersion(binary) {
  const name = String(binary || '').trim();

  if (!name) {
    return null;
  }

  if (versionCache.has(name)) {
    return versionCache.get(name);
  }

  const result = await runCommand(`${name} --version`, {
    allowFailure: true,
    quiet: true
  });
  const version = result.success
    ? result.stdout
        .trim()
        .split(/\r?\n/)[0]
        .replace(/^v/, '')
        .trim() || null
    : null;

  versionCache.set(name, version);
  return version;
}

export async function collectRuntimeEnvironment(packageManager = '') {
  const npmVersion = await getCommandVersion('npm');
  const manager = typeof packageManager === 'string' ? packageManager.trim() : '';
  let packageManagerVersion = null;

  if (manager === 'npm') {
    packageManagerVersion = npmVersion;
  } else if (manager === 'pnpm' || manager === 'yarn') {
    packageManagerVersion = await getCommandVersion(manager);
  }

  return {
    nodeVersion: process.version,
    nodeVersionNumeric: process.version.replace(/^v/, ''),
    npmVersion,
    packageManager: manager || null,
    packageManagerVersion,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osType: os.type(),
    cpuCount: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024))
  };
}
