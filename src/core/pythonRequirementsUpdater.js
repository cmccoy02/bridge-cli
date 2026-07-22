import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CommandExecutionError, runCommand } from './executor.js';
import { normalizePythonName } from './nameNormalizer.js';

// A "clean" exact pin: name[extras]==<pure numeric, dotted version> followed by at
// most an inline `# comment` / trailing whitespace. The version is one or more
// numeric components (==X, ==X.Y, ==X.Y.Z, ==X.Y.Z.W). Anything carrying a
// pre/post/dev/epoch/local segment, an environment marker, or a non-`==` operator
// fails this match and is passed through untouched.
const CLEAN_EXACT_PIN =
  /^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9][A-Za-z0-9._,-]*\])?)(\s*==\s*)(\d+(?:\.\d+)*)((?:\s+#.*)?\s*)$/;

const ZERO_MAJOR_POLICIES = ['minor', 'patch', 'skip'];

// TODO(0.x): 0.x handling is deferred this sprint — skipping is the safe default
// so pip never receives a `0.*` wildcard that could jump a pre-1.0 major. The
// `minor`/`patch` branches in computeWildcard remain wired for when 0.x lands.
export function normalizeZeroMajorPolicy(policy) {
  return ZERO_MAJOR_POLICIES.includes(policy) ? policy : 'skip';
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function splitLine(rawLine) {
  const newlineMatch = rawLine.match(/(\r\n|\n|\r)$/);

  if (!newlineMatch) {
    return { body: rawLine, newline: '' };
  }

  const newline = newlineMatch[1];
  return {
    body: rawLine.slice(0, -newline.length),
    newline
  };
}

function splitRequirementLines(content) {
  if (!content) {
    return [];
  }

  return content
    .match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)
    .filter((line) => line.length > 0);
}

function parseCleanExactPin(lineBody) {
  const match = lineBody.match(CLEAN_EXACT_PIN);

  if (!match) {
    return null;
  }

  const requirement = match[2];
  const version = match[4];
  const components = version.split('.');
  const major = Number.parseInt(components[0], 10);

  if (!Number.isFinite(major)) {
    return null;
  }

  return {
    leading: match[1],
    requirement,
    operator: match[3],
    version,
    components,
    major,
    suffix: match[5],
    normalizedName: normalizePythonName(requirement),
    replaceVersion(nextVersion) {
      return `${match[1]}${requirement}${match[3]}${nextVersion}${match[5]}`;
    }
  };
}

// Classify a passed-through line so the summary can itemize *why* it was left
// untouched. Order matters: more specific reasons win.
function classifyPassthrough(body) {
  const trimmed = body.trim();

  if (trimmed === '') {
    return 'blank';
  }

  if (trimmed.startsWith('#')) {
    return 'comment';
  }

  if (/^--hash\b/.test(trimmed) || trimmed.includes('--hash')) {
    return 'hash';
  }

  if (/^-(r|e|c)\b/.test(trimmed) || /^--(requirement|editable|constraint)\b/.test(trimmed)) {
    return 'include';
  }

  if (trimmed.startsWith('-')) {
    return 'option';
  }

  if (trimmed.includes(';')) {
    return 'environment-marker';
  }

  const operatorMatch = trimmed.match(/(===|==|~=|!=|>=|<=|>|<)/);

  if (!operatorMatch) {
    return 'other';
  }

  if (operatorMatch[1] === '===') {
    return 'arbitrary-equality';
  }

  if (operatorMatch[1] !== '==') {
    return 'non-pin-operator';
  }

  const versionMatch = trimmed.match(/==\s*([^\s#;]+)/);
  const version = versionMatch ? versionMatch[1] : '';

  if (version.includes('!')) {
    return 'epoch';
  }

  if (version.includes('+')) {
    return 'local-version';
  }

  if (/dev\d*/i.test(version)) {
    return 'dev-release';
  }

  if (/post\d*/i.test(version)) {
    return 'post-release';
  }

  if (/(a|b|c|rc|alpha|beta|pre|preview)\d*/i.test(version)) {
    return 'pre-release';
  }

  return 'other';
}

// Decide the wildcard to emit for a clean pin under the given 0.x policy.
// Non-zero majors always wildcard at the major position (`2.3.0 -> 2.*`).
// Returns `null` when the pin should be skipped (0.x with policy "skip").
function computeWildcard(pin, policy) {
  if (pin.major === 0) {
    if (policy === 'skip') {
      return null;
    }

    if (policy === 'patch' && pin.components[1] !== undefined) {
      const minor = pin.components[1];
      return { prefix: `0.${minor}.`, wildcard: `0.${minor}.*` };
    }
  }

  return { prefix: `${pin.major}.`, wildcard: `${pin.major}.*` };
}

function parsePinnedVersions(content) {
  const versions = new Map();

  for (const rawLine of splitRequirementLines(content)) {
    const { body } = splitLine(rawLine);
    const pin = parseCleanExactPin(body);

    if (!pin) {
      continue;
    }

    versions.set(pin.normalizedName, {
      name: pin.requirement,
      version: pin.version
    });
  }

  return versions;
}

export function prepareWildcardRequirements(content, options = {}) {
  const policy = normalizeZeroMajorPolicy(options.zeroMajorPolicy);
  const lines = splitRequirementLines(content);
  const updatablePins = [];
  const outputLines = [];
  let skippedZeroMajor = 0;
  let passedThrough = 0;
  const passedThroughByReason = {};

  for (const rawLine of lines) {
    const { body, newline } = splitLine(rawLine);
    const pin = parseCleanExactPin(body);

    if (!pin) {
      outputLines.push(rawLine);
      passedThrough += 1;
      const reason = classifyPassthrough(body);
      passedThroughByReason[reason] = (passedThroughByReason[reason] || 0) + 1;
      continue;
    }

    const wildcard = computeWildcard(pin, policy);

    if (!wildcard) {
      // 0.x pin with policy "skip": leave byte-identical.
      outputLines.push(rawLine);
      skippedZeroMajor += 1;
      continue;
    }

    pin.wildcardPrefix = wildcard.prefix;
    const wildcardLine = `${pin.leading}${pin.requirement}${pin.operator}${wildcard.wildcard}${pin.suffix}${newline}`;
    outputLines.push(wildcardLine);
    updatablePins.push(pin);
  }

  return {
    content: outputLines.join(''),
    updatablePins,
    skippedZeroMajor,
    passedThrough,
    passedThroughByReason,
    zeroMajorPolicy: policy
  };
}

export function buildResolvedRequirementsContent(originalContent, resolvedContent, updatablePins) {
  const resolvedVersions = parsePinnedVersions(resolvedContent);
  const updatableByName = new Map(updatablePins.map((pin) => [pin.normalizedName, pin]));
  const changes = [];
  const outputLines = [];

  for (const rawLine of splitRequirementLines(originalContent)) {
    const { body, newline } = splitLine(rawLine);
    const pin = parseCleanExactPin(body);

    if (!pin || !updatableByName.has(pin.normalizedName)) {
      outputLines.push(rawLine);
      continue;
    }

    const updatable = updatableByName.get(pin.normalizedName);
    const resolved = resolvedVersions.get(pin.normalizedName);

    if (!resolved) {
      throw new Error(`Resolved output did not include ${pin.requirement}.`);
    }

    // Prefix guard: the resolved version must stay inside the wildcard lane we
    // opened (`2.`, `0.`, or `0.3.`). This uniformly covers the minor lane, 0.x,
    // and the patch policy, and prevents e.g. `0.* -> 1.0`.
    const prefix = updatable.wildcardPrefix;

    if (!resolved.version.startsWith(prefix)) {
      throw new Error(
        `Resolved ${pin.requirement} to ${resolved.version}, which falls outside its wildcard range ${prefix}* (line left unchanged).`
      );
    }

    const nextBody = pin.replaceVersion(resolved.version);
    outputLines.push(`${nextBody}${newline}`);

    if (pin.version !== resolved.version) {
      changes.push({
        name: pin.requirement,
        from: pin.version,
        to: resolved.version
      });
    }
  }

  return {
    content: outputLines.join(''),
    changes
  };
}

// pip phrases an unsatisfiable resolve a few ways, e.g.
//   "Could not find a version that satisfies the requirement <name>==..."
//   "No matching distribution found for <name>==..."
//   "Cannot install <name>... because these package versions have conflicting..."
// Extract the offending package names from whichever wording pip used so we can
// name the original pin the user wrote.
function extractUnsatisfiableNames(stderr) {
  const text = String(stderr || '');
  const names = new Set();
  const patterns = [
    /Could not find a version that satisfies the requirement\s+([A-Za-z0-9][A-Za-z0-9._-]*)/gi,
    /No matching distribution found for\s+([A-Za-z0-9][A-Za-z0-9._-]*)/gi,
    /\bCannot install\s+([A-Za-z0-9][A-Za-z0-9._-]*)/gi,
    /\bThe conflict is caused by:[\s\S]*?\bThe user requested\s+([A-Za-z0-9][A-Za-z0-9._-]*)/gi
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(text)) !== null) {
      names.add(match[1]);
    }
  }

  return [...names];
}

function firstStderrLine(stderr) {
  return String(stderr || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) || 'unknown resolver error';
}

// `pip check` reports conflicting/missing dependencies on stdout (not stderr) and
// exits non-zero. Surface those lines verbatim so the failure names the packages.
function buildCheckError(stdout, stderr, requirementsFile) {
  const details = firstStderrLine(`${String(stdout || '')}\n${String(stderr || '')}`);
  return new Error(
    `Dependency verification (pip check) failed for ${requirementsFile}: ${details} (file left unchanged).`
  );
}

function buildResolveError(stderr, requirementsFile, updatablePins) {
  const names = extractUnsatisfiableNames(stderr);
  const normalizedNames = new Set(names.map((name) => normalizePythonName(name)));

  // Prefer naming the original pins we actually transformed; this filters out
  // any transitive packages pip may mention in a long error trace.
  const offending = updatablePins
    .filter((pin) => normalizedNames.has(pin.normalizedName))
    .map((pin) => `${pin.requirement}==${pin.version}`);

  if (offending.length === 0) {
    return new Error(
      `Cannot resolve dependencies in ${requirementsFile}: ${firstStderrLine(stderr)} (file left unchanged).`
    );
  }

  const verb = offending.length === 1 ? 'is' : 'are';
  return new Error(
    `Cannot resolve: ${offending.join(', ')} ${verb} not available on the index for ${requirementsFile} (line left unchanged).`
  );
}

export function formatPythonRequirementsSummary(summary) {
  const lines = [`Moved packages: ${summary.changes.length}`];

  for (const change of summary.changes) {
    lines.push(`  ${change.name}: ${change.from} -> ${change.to}`);
  }

  lines.push(`Transformed pins: ${summary.transformed}`);

  if (summary.zeroMajorPolicy === 'skip') {
    lines.push(`Skipped 0.x pins: ${summary.skippedZeroMajor}`);
  }

  const reasons = summary.passedThroughByReason || {};
  const itemized = Object.keys(reasons)
    .sort()
    .map((reason) => `${reasons[reason]} ${reason}`);

  lines.push(
    `Passed through: ${summary.passedThrough}${itemized.length ? ` (${itemized.join(', ')})` : ''}`
  );

  return lines;
}

export async function runPythonRequirementsWildcardUpdate({
  cwd,
  runId,
  requirementsFile = 'requirements.txt',
  zeroMajorPolicy = 'skip'
}) {
  const requirementsPath = path.join(cwd, requirementsFile);
  const originalContent = await fs.readFile(requirementsPath, 'utf8');
  const prepared = prepareWildcardRequirements(originalContent, { zeroMajorPolicy });
  const tempBase = path.join(
    os.tmpdir(),
    `bridge.${String(runId || Date.now()).replace(/[^A-Za-z0-9._-]+/g, '-')}`
  );
  // The Bridge-generated wildcards file: a temporary copy with each clean pin
  // rewritten to a single-major `X.*`. The real requirements.txt is never mutated
  // until the resolve + verify both pass.
  const wildcardsPath = `${tempBase}.wildcards.in`;
  const venvPath = path.join(cwd, '.bridge-venv');
  // Invoke the venv's own pip binary directly — no `pip install --python <path>`.
  const venvPip = path.join(venvPath, 'bin', 'pip');

  try {
    await fs.writeFile(wildcardsPath, prepared.content, 'utf8');

    // Lifecycle: clean → create venv, guaranteed in that order so `.bridge-venv`
    // always exists before the install step references it.
    await fs.rm(venvPath, { recursive: true, force: true });
    await runCommand(`python3 -m venv ${quote(venvPath)}`, { cwd, quiet: true });

    // Install the whole wildcard set at once; pip 20.3+ resolves it together.
    try {
      await runCommand(`${quote(venvPip)} install -U -r ${quote(wildcardsPath)}`, {
        cwd,
        quiet: true
      });
    } catch (installError) {
      if (installError instanceof CommandExecutionError) {
        throw buildResolveError(
          `${installError.stderr}\n${installError.stdout}`,
          requirementsFile,
          prepared.updatablePins
        );
      }

      throw installError;
    }

    // Verify no internal conflicts. If pip check fails we abort and write nothing.
    try {
      await runCommand(`${quote(venvPip)} check`, { cwd, quiet: true });
    } catch (checkError) {
      if (checkError instanceof CommandExecutionError) {
        throw buildCheckError(checkError.stdout, checkError.stderr, requirementsFile);
      }

      throw checkError;
    }

    // Capture the fully-resolved, exact versions pip settled on.
    const freezeResult = await runCommand(`${quote(venvPip)} freeze`, { cwd, quiet: true });
    const resolved = buildResolvedRequirementsContent(
      originalContent,
      freezeResult.stdout,
      prepared.updatablePins
    );

    // TODO(verify): run project tests inside the venv once Bridge has a configured test hook.
    // Only written once install + check both pass. Written programmatically (no shell
    // redirection) to avoid the zsh `noclobber` silent no-write.
    await fs.writeFile(requirementsPath, resolved.content, 'utf8');

    return {
      success: true,
      stdout: formatPythonRequirementsSummary({
        changes: resolved.changes,
        transformed: prepared.updatablePins.length,
        skippedZeroMajor: prepared.skippedZeroMajor,
        passedThrough: prepared.passedThrough,
        passedThroughByReason: prepared.passedThroughByReason,
        zeroMajorPolicy: prepared.zeroMajorPolicy
      }).join('\n'),
      stderr: '',
      pythonRequirementsSummary: {
        changes: resolved.changes,
        transformed: prepared.updatablePins.length,
        skippedZeroMajor: prepared.skippedZeroMajor,
        passedThrough: prepared.passedThrough,
        passedThroughByReason: prepared.passedThroughByReason,
        zeroMajorPolicy: prepared.zeroMajorPolicy
      }
    };
  } finally {
    // Teardown: always remove the ephemeral venv and the generated wildcards file.
    await fs.rm(venvPath, { recursive: true, force: true });
    await fs.rm(wildcardsPath, { force: true });
  }
}
