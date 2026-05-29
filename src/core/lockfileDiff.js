import path from 'node:path';

import { normalizePythonName } from './nameNormalizer.js';

const PIP_COMPILE_LINE = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s#;]+)(?:\s+#\s*via\s+(.+))?/i;

function isPythonFormat(format) {
  return (
    format === 'json-pipfile' ||
    format === 'toml-poetry' ||
    format === 'toml-uv' ||
    format === 'pip-compile'
  );
}

function normalizeName(name, format) {
  if (!name) {
    return '';
  }

  const text = String(name).trim();

  if (!text) {
    return '';
  }

  if (isPythonFormat(format)) {
    return normalizePythonName(text);
  }

  return text;
}

function addVersionEntry(map, normalizedName, name, version) {
  if (!normalizedName || !version) {
    return;
  }

  map.set(normalizedName, {
    name: String(name || normalizedName).trim(),
    version: String(version).trim()
  });
}

function nameFromNpmPackagePath(packagePath) {
  if (!packagePath) {
    return '';
  }

  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);

  if (index === -1) {
    return '';
  }

  return packagePath.slice(index + marker.length);
}

function parseNpmV1Dependencies(dependencies, map) {
  if (!dependencies || typeof dependencies !== 'object') {
    return;
  }

  for (const [name, details] of Object.entries(dependencies)) {
    if (!details || typeof details !== 'object') {
      continue;
    }

    if (typeof details.version === 'string' && details.version.trim()) {
      addVersionEntry(map, normalizeName(name, 'json-npm'), name, details.version);
    }

    parseNpmV1Dependencies(details.dependencies, map);
  }
}

function parseNpmLockfile(content) {
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid package-lock.json: ${error.message}`);
  }

  const map = new Map();
  const packages = parsed?.packages;

  if (packages && typeof packages === 'object') {
    for (const [packagePath, details] of Object.entries(packages)) {
      if (!details || typeof details !== 'object') {
        continue;
      }

      if (!details.version || packagePath === '') {
        continue;
      }

      const rawName =
        typeof details.name === 'string' && details.name.trim()
          ? details.name.trim()
          : nameFromNpmPackagePath(packagePath);
      const normalized = normalizeName(rawName, 'json-npm');
      addVersionEntry(map, normalized, rawName, details.version);
    }

    return map;
  }

  parseNpmV1Dependencies(parsed?.dependencies, map);
  return map;
}

function parsePipfileLock(content) {
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid Pipfile.lock: ${error.message}`);
  }

  const map = new Map();
  const groups = [parsed?.default, parsed?.develop];

  for (const group of groups) {
    if (!group || typeof group !== 'object') {
      continue;
    }

    for (const [name, details] of Object.entries(group)) {
      const versionRaw =
        details && typeof details === 'object' ? details.version : '';
      const normalized = normalizeName(name, 'json-pipfile');
      const version =
        typeof versionRaw === 'string'
          ? versionRaw.trim().replace(/^==\s*/, '')
          : '';
      addVersionEntry(map, normalized, name, version);
    }
  }

  return map;
}

function stripTomlComment(text) {
  let quote = '';
  let escaped = false;
  let output = '';

  for (const char of text) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      output += char;
      escaped = true;
      continue;
    }

    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      output += char;
      continue;
    }

    if (quote && char === quote) {
      quote = '';
      output += char;
      continue;
    }

    if (!quote && char === '#') {
      break;
    }

    output += char;
  }

  return output;
}

function parseTomlQuotedValue(raw) {
  const trimmed = raw.trim();

  if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^"((?:\\.|[^"])*)"/);

    if (!match) {
      return '';
    }

    try {
      return JSON.parse(`"${match[1]}"`);
    } catch {
      return match[1];
    }
  }

  if (trimmed.startsWith("'")) {
    const match = trimmed.match(/^'([^']*)'/);
    return match ? match[1] : '';
  }

  return trimmed;
}

function parseTomlPackageLock(content, format) {
  const map = new Map();
  const lines = content.split(/\r?\n/);
  let inPackage = false;
  let currentName = '';
  let currentVersion = '';

  function flushCurrent() {
    if (!inPackage) {
      return;
    }

    const normalized = normalizeName(currentName, format);
    addVersionEntry(map, normalized, currentName, currentVersion);
  }

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();

    if (!line) {
      continue;
    }

    if (line === '[[package]]') {
      flushCurrent();
      inPackage = true;
      currentName = '';
      currentVersion = '';
      continue;
    }

    if (line.startsWith('[[') || line.startsWith('[')) {
      flushCurrent();
      inPackage = false;
      continue;
    }

    if (!inPackage) {
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);

    if (!assignment) {
      continue;
    }

    const key = assignment[1];
    const value = parseTomlQuotedValue(assignment[2]);

    if (key === 'name') {
      currentName = value;
      continue;
    }

    if (key === 'version') {
      currentVersion = value;
    }
  }

  flushCurrent();
  return map;
}

function parsePipCompileLock(content) {
  const map = new Map();
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const match = rawLine.match(PIP_COMPILE_LINE);

    if (!match) {
      continue;
    }

    const rawName = match[1];
    const rawVersion = match[2];
    const normalized = normalizeName(rawName, 'pip-compile');
    addVersionEntry(map, normalized, rawName, rawVersion);
  }

  return map;
}

function extractRequirementName(specifier) {
  const text = String(specifier || '')
    .split(';')[0]
    .trim();

  if (!text) {
    return '';
  }

  const match = text.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return match ? match[1] : '';
}

function parsePackageJsonDirectDeps(content) {
  const parsed = JSON.parse(content);
  const set = new Set();
  const groups = [
    parsed?.dependencies,
    parsed?.devDependencies,
    parsed?.optionalDependencies
  ];

  for (const group of groups) {
    if (!group || typeof group !== 'object') {
      continue;
    }

    for (const name of Object.keys(group)) {
      const normalized = normalizeName(name, 'json-npm');

      if (normalized) {
        set.add(normalized);
      }
    }
  }

  return set;
}

function parsePipfileDirectDeps(content) {
  const set = new Set();
  const lines = content.split(/\r?\n/);
  let section = '';

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();

    if (!line) {
      continue;
    }

    const header = line.match(/^\[([^\]]+)\]$/);

    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }

    if (section !== 'packages' && section !== 'dev-packages') {
      continue;
    }

    const assignment = line.match(/^("([^"]+)"|'([^']+)'|[A-Za-z0-9_.-]+)\s*=/);

    if (!assignment) {
      continue;
    }

    const key = assignment[2] || assignment[3] || assignment[1];
    const normalized = normalizeName(key, 'json-pipfile');

    if (normalized) {
      set.add(normalized);
    }
  }

  return set;
}

function parseRequirementsInDirectDeps(content) {
  const set = new Set();
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    if (/^(-r|-c|--)/i.test(line)) {
      continue;
    }

    const name = extractRequirementName(line);
    const normalized = normalizeName(name, 'pip-compile');

    if (normalized) {
      set.add(normalized);
    }
  }

  return set;
}

function countCharOutsideQuotes(text, target) {
  let quote = '';
  let escaped = false;
  let count = 0;

  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (!quote && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }

    if (quote && char === quote) {
      quote = '';
      continue;
    }

    if (!quote && char === target) {
      count += 1;
    }
  }

  return count;
}

function parseTomlStringArray(text) {
  const values = [];
  const matcher = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'/g;

  for (const match of text.matchAll(matcher)) {
    if (typeof match[1] === 'string') {
      try {
        values.push(JSON.parse(`"${match[1]}"`));
      } catch {
        values.push(match[1]);
      }
      continue;
    }

    if (typeof match[2] === 'string') {
      values.push(match[2].replace(/\\'/g, "'"));
    }
  }

  return values;
}

function parsePyprojectDirectDeps(content) {
  const set = new Set();
  const lines = content.split(/\r?\n/);
  let section = '';
  let collectingArray = false;
  let collectingSection = '';
  let collectingKey = '';
  let arrayBuffer = '';
  let arrayDepth = 0;

  function consumeArray(sectionName, key, text) {
    const specs = parseTomlStringArray(text);

    const addSpecs = (items) => {
      for (const item of items) {
        const name = extractRequirementName(item);
        const normalized = normalizeName(name, 'toml-poetry');

        if (normalized) {
          set.add(normalized);
        }
      }
    };

    if (sectionName === 'project' && key === 'dependencies') {
      addSpecs(specs);
      return;
    }

    if (sectionName === 'tool.uv' && /dev.*dependencies/i.test(key)) {
      addSpecs(specs);
      return;
    }

    if (sectionName === 'dependency-groups' || sectionName === 'tool.uv.dependency-groups') {
      addSpecs(specs);
    }
  }

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();

    if (!line) {
      continue;
    }

    if (!collectingArray) {
      const header = line.match(/^\[([^\]]+)\]$/);

      if (header) {
        section = header[1].trim();
        continue;
      }

      if (
        section === 'tool.poetry.dependencies' ||
        /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)
      ) {
        const assignment = line.match(/^("([^"]+)"|'([^']+)'|[A-Za-z0-9_.-]+)\s*=/);

        if (!assignment) {
          continue;
        }

        const name = assignment[2] || assignment[3] || assignment[1];

        if (name.toLowerCase() === 'python') {
          continue;
        }

        const normalized = normalizeName(name, 'toml-poetry');

        if (normalized) {
          set.add(normalized);
        }

        continue;
      }

      const arrayAssignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*\[(.*)$/);

      if (!arrayAssignment) {
        continue;
      }

      collectingArray = true;
      collectingSection = section;
      collectingKey = arrayAssignment[1];
      arrayBuffer = arrayAssignment[2];
      arrayDepth =
        1 +
        countCharOutsideQuotes(arrayBuffer, '[') -
        countCharOutsideQuotes(arrayBuffer, ']');

      if (arrayDepth <= 0) {
        consumeArray(collectingSection, collectingKey, arrayBuffer);
        collectingArray = false;
        collectingSection = '';
        collectingKey = '';
        arrayBuffer = '';
        arrayDepth = 0;
      }

      continue;
    }

    arrayBuffer += `\n${line}`;
    arrayDepth +=
      countCharOutsideQuotes(line, '[') - countCharOutsideQuotes(line, ']');

    if (arrayDepth <= 0) {
      consumeArray(collectingSection, collectingKey, arrayBuffer);
      collectingArray = false;
      collectingSection = '';
      collectingKey = '';
      arrayBuffer = '';
      arrayDepth = 0;
    }
  }

  return set;
}

function parsePipCompileViaHints(content) {
  const viaByPackage = new Map();
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const match = rawLine.match(PIP_COMPILE_LINE);

    if (!match) {
      continue;
    }

    const rawName = match[1];
    const via = (match[3] || '').trim();

    if (!via) {
      continue;
    }

    const normalized = normalizeName(rawName, 'pip-compile');

    if (normalized) {
      viaByPackage.set(normalized, via);
    }
  }

  return viaByPackage;
}

function isDirectByPipCompileVia(viaText) {
  if (!viaText) {
    return null;
  }

  if (/(^|[\s,])(-r\s+)?[^\s,]*\.in\b/i.test(viaText)) {
    return true;
  }

  return false;
}

function createEmptySummary() {
  return {
    totalChanged: 0,
    added: 0,
    removed: 0,
    directChanged: 0,
    transitiveChanged: 0,
    byBump: {
      patch: 0,
      minor: 0,
      major: 0,
      other: 0
    }
  };
}

function parseNumericVersionCore(version) {
  const text = String(version || '').trim();

  if (!text) {
    return null;
  }

  const match = text.match(/^(\d+(?:\.\d+)*)/);

  if (!match) {
    return null;
  }

  const parts = [];

  for (const rawPart of match[1].split('.')) {
    const parsed = Number.parseInt(rawPart, 10);

    if (!Number.isFinite(parsed)) {
      return null;
    }

    parts.push(parsed);
  }

  while (parts.length < 3) {
    parts.push(0);
  }

  return parts.slice(0, 3);
}

function classifyDeltaKind({
  normalizedName,
  lockfileFormat,
  directDeps,
  beforeViaByPackage,
  afterViaByPackage
}) {
  if (lockfileFormat === 'pip-compile') {
    const via = afterViaByPackage.get(normalizedName) || beforeViaByPackage.get(normalizedName);
    const directByVia = isDirectByPipCompileVia(via);

    if (directByVia === true) {
      return 'direct';
    }

    if (directByVia === false) {
      return 'transitive';
    }
  }

  return directDeps.has(normalizedName) ? 'direct' : 'transitive';
}

export function parseLockfile(content, format) {
  if (!format) {
    return new Map();
  }

  const text = typeof content === 'string' ? content : '';

  switch (format) {
    case 'json-npm':
      return parseNpmLockfile(text);
    case 'json-pipfile':
      return parsePipfileLock(text);
    case 'toml-poetry':
    case 'toml-uv':
      return parseTomlPackageLock(text, format);
    case 'pip-compile':
      return parsePipCompileLock(text);
    default:
      return new Map();
  }
}

export function parseDirectDeps(content, manifestFile, { onWarning } = {}) {
  if (!manifestFile || typeof content !== 'string') {
    return new Set();
  }

  const fileName = path.basename(manifestFile).toLowerCase();

  try {
    if (fileName === 'package.json') {
      return parsePackageJsonDirectDeps(content);
    }

    if (fileName === 'pipfile') {
      return parsePipfileDirectDeps(content);
    }

    if (fileName === 'requirements.in') {
      return parseRequirementsInDirectDeps(content);
    }

    if (fileName === 'pyproject.toml') {
      return parsePyprojectDirectDeps(content);
    }
  } catch (error) {
    if (typeof onWarning === 'function') {
      onWarning(error);
    }
  }

  return new Set();
}

export function classifyBump(from, to) {
  const fromParts = parseNumericVersionCore(from);
  const toParts = parseNumericVersionCore(to);

  if (!fromParts || !toParts) {
    return 'other';
  }

  if (fromParts[0] !== toParts[0]) {
    return 'major';
  }

  if (fromParts[1] !== toParts[1]) {
    return 'minor';
  }

  if (fromParts[2] !== toParts[2]) {
    return 'patch';
  }

  return 'other';
}

export function computeDepDeltas({
  beforeContent,
  afterContent,
  lockfileFormat,
  directDeps = new Set()
}) {
  const beforeMap = parseLockfile(beforeContent, lockfileFormat);
  const afterMap = parseLockfile(afterContent, lockfileFormat);
  const beforeViaByPackage =
    lockfileFormat === 'pip-compile'
      ? parsePipCompileViaHints(beforeContent || '')
      : new Map();
  const afterViaByPackage =
    lockfileFormat === 'pip-compile'
      ? parsePipCompileViaHints(afterContent || '')
      : new Map();
  const summary = createEmptySummary();
  const deltas = [];
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  for (const normalizedName of keys) {
    const fromEntry = beforeMap.get(normalizedName);
    const toEntry = afterMap.get(normalizedName);

    if (fromEntry && toEntry && fromEntry.version === toEntry.version) {
      continue;
    }

    const kind = classifyDeltaKind({
      normalizedName,
      lockfileFormat,
      directDeps,
      beforeViaByPackage,
      afterViaByPackage
    });
    const fromVersion = fromEntry ? fromEntry.version : null;
    const toVersion = toEntry ? toEntry.version : null;
    let bump = 'other';

    if (!fromEntry && toEntry) {
      bump = 'added';
      summary.added += 1;
    } else if (fromEntry && !toEntry) {
      bump = 'removed';
      summary.removed += 1;
    } else if (fromEntry && toEntry) {
      bump = classifyBump(fromEntry.version, toEntry.version);

      if (Object.prototype.hasOwnProperty.call(summary.byBump, bump)) {
        summary.byBump[bump] += 1;
      } else {
        summary.byBump.other += 1;
      }
    }

    summary.totalChanged += 1;

    if (kind === 'direct') {
      summary.directChanged += 1;
    } else {
      summary.transitiveChanged += 1;
    }

    deltas.push({
      normalizedName,
      name: (toEntry?.name || fromEntry?.name || normalizedName).trim(),
      from: fromVersion,
      to: toVersion,
      bump,
      kind
    });
  }

  deltas.sort((a, b) => a.name.localeCompare(b.name));
  return { deltas, summary };
}

export function mergeDepDeltaSummaries(base, next) {
  const merged = createEmptySummary();
  const left = base || createEmptySummary();
  const right = next || createEmptySummary();

  merged.totalChanged = left.totalChanged + right.totalChanged;
  merged.added = left.added + right.added;
  merged.removed = left.removed + right.removed;
  merged.directChanged = left.directChanged + right.directChanged;
  merged.transitiveChanged = left.transitiveChanged + right.transitiveChanged;
  merged.byBump.patch = left.byBump.patch + right.byBump.patch;
  merged.byBump.minor = left.byBump.minor + right.byBump.minor;
  merged.byBump.major = left.byBump.major + right.byBump.major;
  merged.byBump.other = left.byBump.other + right.byBump.other;

  return merged;
}

export function createDepDeltaSummary() {
  return createEmptySummary();
}
