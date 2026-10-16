import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function readPackageVersion() {
  return String(packageJson.version || '0.0.0');
}

export function readBridgeGitSha({ cwd = REPO_ROOT, execFile = execFileSync } = {}) {
  try {
    const sha = execFile('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    return sha || '';
  } catch {
    return '';
  }
}

export function getBridgeVersion(options = {}) {
  const version = readPackageVersion();
  const sha = readBridgeGitSha(options);
  return sha ? `${version} (${sha})` : version;
}
