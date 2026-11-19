import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEPENDENCY_ARTIFACT_BASENAMES } from '../constants.js';

// A handoff bundle carries the result of `bridge patch --handoff` (which runs package
// code and therefore holds no write credentials) to `bridge publish` (which holds the
// bot token and runs no package code). Everything read from a bundle is untrusted:
// the reader re-validates paths, sizes, hashes and the branch name.

export const HANDOFF_SCHEMA = 'bridge-handoff.v1';
export const HANDOFF_FILE = 'handoff.json';
export const HANDOFF_REPORT_FILE = 'bridge-report.v1.json';
export const HANDOFF_FILES_DIR = 'files';
export const HANDOFF_STATUSES = new Set(['ready', 'up_to_date', 'blocked', 'failed']);

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_BODY_CHARS = 60000;
const MAX_MESSAGE_CHARS = 2000;
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;
const MARKER_RE = /<!--\s*bridge-meta:[\s\S]*?-->/g;

export class HandoffError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HandoffError';
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function validateHandoffPath(candidate) {
  const raw = String(candidate ?? '');

  if (!raw || raw.includes('\0') || raw.includes('\\')) {
    throw new HandoffError(`Refusing unsafe file path in handoff: ${JSON.stringify(raw)}`);
  }

  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new HandoffError(`Refusing absolute path in handoff: ${raw}`);
  }

  const normalized = path.posix.normalize(raw);
  const segments = normalized.split('/');

  if (
    normalized !== raw ||
    segments.some((segment) => segment === '..' || segment === '.' || segment === '') ||
    segments[0] === '.git' ||
    segments.includes('node_modules')
  ) {
    throw new HandoffError(`Refusing path outside the dependency allowlist: ${raw}`);
  }

  if (!DEPENDENCY_ARTIFACT_BASENAMES.has(segments[segments.length - 1])) {
    throw new HandoffError(
      `Refusing ${raw}: Bridge only publishes dependency manifests and lockfiles.`
    );
  }

  return normalized;
}

export function validateBranchName(branchName, { requiredPrefix = 'bridge/' } = {}) {
  const name = String(branchName || '').trim();

  if (
    !name ||
    !BRANCH_NAME_RE.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.lock')
  ) {
    throw new HandoffError(`Refusing unsafe branch name: ${JSON.stringify(name)}`);
  }

  if (requiredPrefix && !name.startsWith(requiredPrefix)) {
    throw new HandoffError(
      `Refusing branch "${name}": Bridge only pushes branches that start with "${requiredPrefix}".`
    );
  }

  return name;
}

export function sanitizePullRequestBody(body) {
  return String(body || '')
    .replace(MARKER_RE, '')
    .slice(0, MAX_BODY_CHARS)
    .trim();
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (readError) {
    if (readError?.code === 'ENOENT') {
      return null;
    }

    throw new HandoffError(`Unreadable handoff file ${path.basename(filePath)}: ${readError.message}`);
  }
}

export async function writeHandoffBundle({
  handoffDir,
  workspaceDir,
  stagedFiles = [],
  runId,
  repository = null,
  base = {},
  branch = {},
  scopeKey = '',
  pullRequest = {},
  summary = {},
  message = ''
}) {
  const filesDir = path.join(handoffDir, HANDOFF_FILES_DIR);
  await fs.rm(filesDir, { recursive: true, force: true });
  await fs.mkdir(filesDir, { recursive: true });

  if (stagedFiles.length > MAX_FILES) {
    throw new HandoffError(`Too many changed files for one handoff (${stagedFiles.length}).`);
  }

  const files = [];
  let totalBytes = 0;

  for (const stagedFile of stagedFiles) {
    const relativePath = validateHandoffPath(stagedFile);
    const sourcePath = path.join(workspaceDir, ...relativePath.split('/'));
    let stats;

    try {
      stats = await fs.lstat(sourcePath);
    } catch (statError) {
      if (statError?.code === 'ENOENT') {
        throw new HandoffError(`Bridge does not publish file deletions (${relativePath}).`);
      }

      throw statError;
    }

    if (!stats.isFile()) {
      throw new HandoffError(`Refusing ${relativePath}: not a regular file.`);
    }

    const content = await fs.readFile(sourcePath);
    totalBytes += content.length;

    if (content.length > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      throw new HandoffError('Changed files are too large for a handoff bundle.');
    }

    const destination = path.join(filesDir, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, content);
    files.push({ path: relativePath, sha256: sha256(content), bytes: content.length });
  }

  const manifest = {
    schema: HANDOFF_SCHEMA,
    createdAt: new Date().toISOString(),
    status: 'ready',
    runId,
    repository,
    base,
    branch,
    scopeKey,
    pullRequest,
    summary,
    message,
    files,
    report: HANDOFF_REPORT_FILE
  };
  await fs.writeFile(path.join(handoffDir, HANDOFF_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * Records a run that produced nothing to publish (up to date, blocked, failed), so the
 * publish job can still upload the report. Never overwrites a ready bundle.
 */
export async function writeHandoffOutcome({
  handoffDir,
  runId,
  status,
  repository = null,
  message = '',
  gateType = ''
}) {
  const manifestPath = path.join(handoffDir, HANDOFF_FILE);
  const existing = await readJson(manifestPath).catch(() => null);

  if (existing?.status === 'ready' && existing?.runId === runId) {
    return existing;
  }

  const manifest = {
    schema: HANDOFF_SCHEMA,
    createdAt: new Date().toISOString(),
    status: HANDOFF_STATUSES.has(status) ? status : 'failed',
    runId,
    repository,
    gateType: gateType || '',
    message: String(message || '').slice(0, MAX_MESSAGE_CHARS),
    files: [],
    report: HANDOFF_REPORT_FILE
  };
  await fs.mkdir(handoffDir, { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readHandoffBundle(handoffDir, { requiredBranchPrefix = 'bridge/' } = {}) {
  const manifest = await readJson(path.join(handoffDir, HANDOFF_FILE));

  if (!manifest) {
    throw new HandoffError(
      `No ${HANDOFF_FILE} in ${handoffDir}. The update job did not produce a handoff bundle.`
    );
  }

  if (manifest.schema !== HANDOFF_SCHEMA) {
    throw new HandoffError(`Unsupported handoff schema: ${manifest.schema}`);
  }

  if (!HANDOFF_STATUSES.has(manifest.status)) {
    throw new HandoffError(`Unknown handoff status: ${manifest.status}`);
  }

  const report = await readJson(path.join(handoffDir, HANDOFF_REPORT_FILE)).catch(() => null);
  const message = String(manifest.message || '').slice(0, MAX_MESSAGE_CHARS);

  if (manifest.status !== 'ready') {
    return { manifest: { ...manifest, message }, files: [], report };
  }

  const entries = Array.isArray(manifest.files) ? manifest.files : [];

  if (entries.length === 0 || entries.length > MAX_FILES) {
    throw new HandoffError('A ready handoff must list between 1 and 200 files.');
  }

  const branchName = validateBranchName(manifest.branch?.name, {
    requiredPrefix: requiredBranchPrefix
  });
  const baseSha = String(manifest.base?.sha || '').trim();

  if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
    throw new HandoffError('Handoff is missing a full base commit SHA.');
  }

  const files = [];
  const seen = new Set();
  let totalBytes = 0;

  for (const entry of entries) {
    const relativePath = validateHandoffPath(entry?.path);

    if (seen.has(relativePath)) {
      throw new HandoffError(`Duplicate file in handoff: ${relativePath}`);
    }

    seen.add(relativePath);
    const sourcePath = path.join(handoffDir, HANDOFF_FILES_DIR, ...relativePath.split('/'));
    const stats = await fs.lstat(sourcePath).catch(() => null);

    if (!stats?.isFile()) {
      throw new HandoffError(`Handoff file missing or not a regular file: ${relativePath}`);
    }

    if (stats.size > MAX_FILE_BYTES) {
      throw new HandoffError(`Handoff file too large: ${relativePath}`);
    }

    totalBytes += stats.size;

    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new HandoffError('Handoff files are too large in total.');
    }

    const content = await fs.readFile(sourcePath);

    if (sha256(content) !== String(entry.sha256 || '').toLowerCase()) {
      throw new HandoffError(`Checksum mismatch for ${relativePath}.`);
    }

    files.push({ path: relativePath, content });
  }

  return {
    manifest: {
      ...manifest,
      message,
      branch: { ...manifest.branch, name: branchName },
      base: { ...manifest.base, sha: baseSha.toLowerCase() },
      pullRequest: {
        ...(manifest.pullRequest || {}),
        title: String(manifest.pullRequest?.title || '').slice(0, 200),
        body: sanitizePullRequestBody(manifest.pullRequest?.body)
      }
    },
    files,
    report
  };
}

// package.json may only change inside dependency sections. Anything else (scripts,
// bin, workspaces, publishConfig...) means the update job did more than update deps.
const DEPENDENCY_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
  'resolutions'
]);

function withoutPnpmOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const { overrides: _overrides, ...rest } = value;
  void _overrides;
  return rest;
}

export function findNonDependencyManifestChanges(beforeText, afterText) {
  let before;
  let after;

  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return ['(unparseable package.json)'];
  }

  const changed = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);

  for (const key of keys) {
    if (DEPENDENCY_SECTIONS.has(key)) {
      continue;
    }

    const left = key === 'pnpm' ? withoutPnpmOverrides(before?.[key]) : before?.[key];
    const right = key === 'pnpm' ? withoutPnpmOverrides(after?.[key]) : after?.[key];

    if (JSON.stringify(left) !== JSON.stringify(right)) {
      changed.push(key);
    }
  }

  return changed;
}
