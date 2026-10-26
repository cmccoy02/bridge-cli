import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD_INFO_PATH = path.join(REPO_ROOT, 'build-info.json');
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;

export function readPackageVersion() {
  return String(packageJson.version || '0.0.0');
}

export function getBuildInfoPath() {
  return BUILD_INFO_PATH;
}

function realPath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

// Only trust git when `cwd` is the top of its own checkout. An installed copy
// (e.g. node_modules/bridge-cli inside someone's repo) has no .git, so git would
// walk up and report the host repo's commit as Bridge's.
export function readBridgeGitSha({ cwd = REPO_ROOT, execFile = execFileSync } = {}) {
  try {
    const [topLevel = '', sha = ''] = execFile(
      'git',
      ['rev-parse', '--show-toplevel', '--short', 'HEAD'],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
      .toString()
      .trim()
      .split(/\r?\n/)
      .map((value) => value.trim());

    if (!topLevel || realPath(topLevel) !== realPath(cwd)) {
      return '';
    }

    return GIT_SHA_RE.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

// Published packages carry the commit in build-info.json, written on `npm pack`.
export function readBuildInfoSha({ buildInfoPath = BUILD_INFO_PATH } = {}) {
  try {
    const info = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    const sha = String(info?.gitSha || '').trim();
    return GIT_SHA_RE.test(sha) ? sha : '';
  } catch {
    return '';
  }
}

export function writeBuildInfo({ buildInfoPath = BUILD_INFO_PATH, cwd = REPO_ROOT } = {}) {
  const gitSha = readBridgeGitSha({ cwd });

  if (!gitSha) {
    fs.rmSync(buildInfoPath, { force: true });
    return { written: false, gitSha: '' };
  }

  fs.writeFileSync(buildInfoPath, `${JSON.stringify({ gitSha }, null, 2)}\n`, 'utf8');
  return { written: true, gitSha };
}

export function getBridgeVersion(options = {}) {
  const version = readPackageVersion();
  const sha = readBridgeGitSha(options) || readBuildInfoSha(options);
  return sha ? `${version} (${sha})` : version;
}
