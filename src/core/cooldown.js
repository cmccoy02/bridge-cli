import fs from 'node:fs/promises';
import path from 'node:path';

import { runCommand } from './executor.js';

// Release-age cooldown: Bridge never proposes a version until it has been public
// for `cooldownDays`. Two layers:
//   1. Native: the package manager's own setting is passed to the update command, so
//      the resolver picks older versions instead of too-new ones.
//   2. Verification: after the update, every changed version's publish time is checked
//      against the public registry. Anything too new blocks the run (gate `cooldown_block`).

export const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
export const PYPI_URL = 'https://pypi.org';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const NATIVE_MIN_VERSIONS = {
  npm: '11.10.0',
  pnpm: '10.16.0',
  yarn: '4.10.0'
};

export function ecosystemForLockfileFormat(format) {
  switch (format) {
    case 'json-npm':
    case 'yarn-lock':
    case 'yaml-pnpm':
      return 'npm';
    case 'toml-poetry':
    case 'json-pipfile':
    case 'pip-compile':
    case 'toml-uv':
      return 'pypi';
    default:
      return null;
  }
}

export function compareVersions(left, right) {
  const parse = (value) =>
    String(value || '')
      .trim()
      .replace(/^v/, '')
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);

  for (let index = 0; index < Math.max(a.length, b.length, 3); index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);

    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }

  return 0;
}

function patternToRegExp(pattern) {
  const escaped = String(pattern)
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesCooldownExclude(name, patterns = []) {
  const candidate = String(name || '').trim();

  return (Array.isArray(patterns) ? patterns : []).some((pattern) => {
    const value = String(pattern || '').trim();
    return value ? patternToRegExp(value).test(candidate) : false;
  });
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function envHas(env, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));

  return Object.entries(env || {}).some(
    ([name, value]) => wanted.has(name.toLowerCase()) && String(value ?? '').trim() !== ''
  );
}

async function findDeclaredSetting(directories, checks) {
  for (const directory of directories) {
    for (const { file, pattern } of checks) {
      const text = await readTextIfExists(path.join(directory, file));

      if (text && pattern.test(text)) {
        return path.join(directory, file);
      }
    }
  }

  return '';
}

async function detectManagerVersion(manager, cwd) {
  const result = await runCommand(`${manager} --version`, {
    cwd,
    allowFailure: true,
    quiet: true
  });

  if (!result.success) {
    return null;
  }

  const version = result.stdout.trim().split(/\r?\n/).pop()?.replace(/^v/, '').trim();
  return version || null;
}

/**
 * Works out which environment variables give the update command a native release-age
 * gate. Never weakens a setting the repository (or environment) already declares.
 */
export async function resolveNativeCooldown({
  packageManager = '',
  days = 0,
  scopeDir = process.cwd(),
  rootDir = scopeDir,
  env = process.env,
  enabled = true,
  versionFn = detectManagerVersion
} = {}) {
  const manager = String(packageManager || '').trim();
  const native = {
    manager: manager || null,
    version: null,
    applied: false,
    setting: '',
    value: '',
    reason: '',
    env: {}
  };
  const directories = [...new Set([scopeDir, rootDir].filter(Boolean))];

  if (!(days > 0)) {
    native.reason = 'cooldown is off (cooldownDays is 0)';
    return native;
  }

  if (!enabled) {
    native.reason = 'native enforcement turned off (cooldownNative: false); publish dates are still verified';
    return native;
  }

  if (!Object.prototype.hasOwnProperty.call(NATIVE_MIN_VERSIONS, manager)) {
    native.reason = `${manager || 'this package manager'} has no native release-age setting Bridge can drive; publish dates are verified instead`;
    return native;
  }

  let declaredIn = '';

  if (manager === 'npm') {
    declaredIn = envHas(env, ['npm_config_min_release_age', 'npm_config_before'])
      ? 'environment'
      : await findDeclaredSetting(directories, [
          { file: '.npmrc', pattern: /^\s*(min-release-age|before)\s*=/m }
        ]);
  } else if (manager === 'pnpm') {
    declaredIn = envHas(env, [
      'npm_config_minimum_release_age',
      'pnpm_config_minimum_release_age'
    ])
      ? 'environment'
      : await findDeclaredSetting(directories, [
          { file: 'pnpm-workspace.yaml', pattern: /^\s*minimumReleaseAge\s*:/m },
          { file: '.npmrc', pattern: /^\s*minimum-release-age\s*=/m },
          { file: 'package.json', pattern: /"minimumReleaseAge"\s*:/ }
        ]);
  } else if (manager === 'yarn') {
    declaredIn = envHas(env, ['YARN_NPM_MINIMAL_AGE_GATE'])
      ? 'environment'
      : await findDeclaredSetting(directories, [
          { file: '.yarnrc.yml', pattern: /^\s*npmMinimalAgeGate\s*:/m }
        ]);
  }

  if (declaredIn) {
    native.reason = `respecting the release-age setting already declared in ${declaredIn === 'environment' ? 'the environment' : path.basename(declaredIn)}`;
    return native;
  }

  native.version = await versionFn(manager, scopeDir);
  const minimum = NATIVE_MIN_VERSIONS[manager];

  if (!native.version || compareVersions(native.version, minimum) < 0) {
    native.reason = `${manager} ${native.version || '(version unknown)'} predates native release-age support (${minimum}+); publish dates are verified instead`;
    return native;
  }

  const minutes = Math.ceil(days * 24 * 60);

  if (manager === 'npm') {
    native.setting = 'min-release-age';
    native.value = `${Math.ceil(days)} days`;
    native.env = { npm_config_min_release_age: String(Math.ceil(days)) };
  } else if (manager === 'pnpm') {
    native.setting = 'minimumReleaseAge';
    native.value = `${minutes} minutes`;
    native.env = {
      npm_config_minimum_release_age: String(minutes),
      PNPM_CONFIG_MINIMUM_RELEASE_AGE: String(minutes)
    };
  } else {
    native.setting = 'npmMinimalAgeGate';
    native.value = `${minutes} minutes`;
    native.env = { YARN_NPM_MINIMAL_AGE_GATE: String(minutes) };
  }

  native.applied = true;
  native.reason = `${manager} ${native.version} enforces ${native.setting}=${native.value} during the update`;
  return native;
}

function encodeNpmName(name) {
  return name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
}

class LookupError extends Error {
  constructor(message, { notFound = false } = {}) {
    super(message);
    this.notFound = notFound;
  }
}

async function fetchJson(url, { fetchImpl, timeoutMs }) {
  let response;

  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new LookupError(error?.name === 'TimeoutError' ? 'registry request timed out' : `registry request failed (${error?.message || error})`);
  }

  if (response.status === 404) {
    throw new LookupError('not found on the public registry (private package?)', { notFound: true });
  }

  if (!response.ok) {
    throw new LookupError(`registry answered HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();

  if (buffer.byteLength > MAX_METADATA_BYTES) {
    throw new LookupError('registry metadata too large to check');
  }

  try {
    return JSON.parse(Buffer.from(buffer).toString('utf8'));
  } catch {
    throw new LookupError('registry returned unreadable metadata');
  }
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function earliest(times) {
  const parsed = times
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  return parsed.length > 0 ? new Date(parsed[0]).toISOString() : '';
}

/**
 * Verifies that every version Bridge is about to propose has been public for `days`.
 */
export async function checkReleaseAgeCooldown({
  deltas = [],
  lockfileFormat = null,
  days = 0,
  exclude = [],
  label = 'root',
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  npmRegistryUrl = NPM_REGISTRY_URL,
  pypiUrl = PYPI_URL,
  concurrency = 6,
  timeoutMs = 20000
} = {}) {
  const ecosystem = ecosystemForLockfileFormat(lockfileFormat);
  const result = {
    label,
    days,
    ecosystem,
    checked: 0,
    passed: 0,
    violations: [],
    unverified: [],
    excluded: [],
    skippedReason: ''
  };

  if (!(days > 0)) {
    result.skippedReason = 'cooldown is off';
    return result;
  }

  if (!ecosystem) {
    result.skippedReason = 'no public publish-date source for this ecosystem yet';
    return result;
  }

  const seen = new Set();
  const candidates = [];

  for (const delta of Array.isArray(deltas) ? deltas : []) {
    const name = String(delta?.name || '').trim();
    const version = String(delta?.to || '').trim();

    if (!name || !version || delta?.bump === 'removed') {
      continue;
    }

    // npm workspace packages live outside node_modules and are never published.
    if (
      lockfileFormat === 'json-npm' &&
      delta.dependencyPath &&
      !String(delta.dependencyPath).includes('node_modules/')
    ) {
      continue;
    }

    const key = `${name}@${version}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    if (matchesCooldownExclude(name, exclude)) {
      result.excluded.push({ name, version });
      continue;
    }

    candidates.push({ name, version, kind: delta.kind || 'transitive' });
  }

  const npmMetadata = new Map();
  const windowMs = days * DAY_MS;

  const lookupPublishedAt = async ({ name, version }) => {
    if (ecosystem === 'npm') {
      if (!npmMetadata.has(name)) {
        npmMetadata.set(
          name,
          fetchJson(`${npmRegistryUrl.replace(/\/$/, '')}/${encodeNpmName(name)}`, {
            fetchImpl,
            timeoutMs
          })
        );
      }

      const packument = await npmMetadata.get(name);
      return packument?.time?.[version] || '';
    }

    const release = await fetchJson(
      `${pypiUrl.replace(/\/$/, '')}/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
      { fetchImpl, timeoutMs }
    );
    return earliest(
      (Array.isArray(release?.urls) ? release.urls : []).map(
        (file) => file?.upload_time_iso_8601 || file?.upload_time
      )
    );
  };

  await runPool(candidates, concurrency, async (candidate) => {
    let publishedAt = '';

    try {
      publishedAt = await lookupPublishedAt(candidate);
    } catch (error) {
      result.unverified.push({ ...candidate, reason: error?.message || String(error) });
      return;
    }

    const publishedMs = Date.parse(publishedAt);

    if (!publishedAt || !Number.isFinite(publishedMs)) {
      result.unverified.push({ ...candidate, reason: 'registry did not report a publish time' });
      return;
    }

    result.checked += 1;
    const ageMs = now - publishedMs;

    if (ageMs < windowMs) {
      result.violations.push({
        ...candidate,
        publishedAt: new Date(publishedMs).toISOString(),
        ageHours: Math.max(0, Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10),
        eligibleAt: new Date(publishedMs + windowMs).toISOString()
      });
      return;
    }

    result.passed += 1;
  });

  result.violations.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  result.unverified.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

function formatAge(hours) {
  if (hours < 1) {
    return 'under an hour ago';
  }

  if (hours < 48) {
    return `${Math.round(hours)}h ago`;
  }

  return `${Math.round(hours / 24)}d ago`;
}

export function formatCooldownViolations(result, { limit = 5 } = {}) {
  const violations = result?.violations || [];
  const examples = violations
    .slice(0, limit)
    .map(
      (entry) =>
        `${entry.name} ${entry.version} (published ${formatAge(entry.ageHours)}, eligible ${entry.eligibleAt.slice(0, 10)})`
    )
    .join(', ');
  const extra = violations.length > limit ? ` and ${violations.length - limit} more` : '';

  return (
    `Release-age cooldown (${result.days} day${result.days === 1 ? '' : 's'}) blocked ${violations.length} version${violations.length === 1 ? '' : 's'} in ${result.label}: ${examples}${extra}. ` +
    'Bridge will propose them once they have been public long enough. ' +
    'To take one sooner, add it to "cooldownExclude" after reviewing it.'
  );
}

export function summarizeCooldownResults(results = []) {
  const list = (Array.isArray(results) ? results : []).filter(Boolean);
  const days = list.find((entry) => entry.days > 0)?.days || 0;

  return {
    days,
    checked: list.reduce((sum, entry) => sum + (entry.checked || 0), 0),
    passed: list.reduce((sum, entry) => sum + (entry.passed || 0), 0),
    violations: list.flatMap((entry) =>
      (entry.violations || []).map((violation) => ({ scope: entry.label, ...violation }))
    ),
    unverified: list.flatMap((entry) =>
      (entry.unverified || []).map((item) => ({ scope: entry.label, ...item }))
    ),
    excluded: list.flatMap((entry) =>
      (entry.excluded || []).map((item) => ({ scope: entry.label, ...item }))
    ),
    native: list.map((entry) => ({ scope: entry.label, ...(entry.native || {}), env: undefined })),
    scopes: list.map((entry) => ({
      scope: entry.label,
      ecosystem: entry.ecosystem,
      checked: entry.checked || 0,
      violations: (entry.violations || []).length,
      unverified: (entry.unverified || []).length,
      skippedReason: entry.skippedReason || ''
    }))
  };
}
