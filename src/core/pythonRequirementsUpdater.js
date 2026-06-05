import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from './executor.js';
import { normalizePythonName } from './nameNormalizer.js';

const CLEAN_EXACT_PIN =
  /^(\s*)([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9][A-Za-z0-9._,-]*\])?)(\s*==\s*)(\d+)\.(\d+)\.(\d+)((?:\s+#.*)?\s*)$/;

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
  const version = `${match[4]}.${match[5]}.${match[6]}`;
  const major = Number.parseInt(match[4], 10);

  if (!Number.isFinite(major)) {
    return null;
  }

  return {
    leading: match[1],
    requirement,
    operator: match[3],
    version,
    major,
    suffix: match[7],
    normalizedName: normalizePythonName(requirement),
    replaceVersion(nextVersion) {
      return `${match[1]}${requirement}${match[3]}${nextVersion}${match[7]}`;
    }
  };
}

function parseMajor(version) {
  const match = String(version || '').match(/^(\d+)\./);

  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
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

export function prepareWildcardRequirements(content) {
  const lines = splitRequirementLines(content);
  const updatablePins = [];
  const outputLines = [];
  let skippedZeroMajor = 0;
  let passedThrough = 0;

  for (const rawLine of lines) {
    const { body, newline } = splitLine(rawLine);
    const pin = parseCleanExactPin(body);

    if (!pin) {
      outputLines.push(rawLine);
      passedThrough += 1;
      continue;
    }

    if (pin.major === 0) {
      // TODO(0.x): add a 0.x-aware upper bound strategy later; leave 0.x pins byte-identical for now.
      outputLines.push(rawLine);
      skippedZeroMajor += 1;
      continue;
    }

    const wildcardLine = `${pin.leading}${pin.requirement}${pin.operator}${pin.major}.*${pin.suffix}${newline}`;
    outputLines.push(wildcardLine);
    updatablePins.push(pin);
  }

  return {
    content: outputLines.join(''),
    updatablePins,
    skippedZeroMajor,
    passedThrough
  };
}

export function buildResolvedRequirementsContent(originalContent, resolvedContent, updatablePins) {
  const resolvedVersions = parsePinnedVersions(resolvedContent);
  const updatableNames = new Set(updatablePins.map((pin) => pin.normalizedName));
  const changes = [];
  const outputLines = [];

  for (const rawLine of splitRequirementLines(originalContent)) {
    const { body, newline } = splitLine(rawLine);
    const pin = parseCleanExactPin(body);

    if (!pin || !updatableNames.has(pin.normalizedName)) {
      outputLines.push(rawLine);
      continue;
    }

    const resolved = resolvedVersions.get(pin.normalizedName);

    if (!resolved) {
      throw new Error(`Resolved output did not include ${pin.requirement}.`);
    }

    const resolvedMajor = parseMajor(resolved.version);

    if (resolvedMajor !== pin.major) {
      throw new Error(
        `Resolved ${pin.requirement} to ${resolved.version}, which crosses major ${pin.major}.`
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

export function formatPythonRequirementsSummary(summary) {
  const lines = [
    `Moved packages: ${summary.changes.length}`,
    `Skipped 0.x pins: ${summary.skippedZeroMajor}`
  ];

  for (const change of summary.changes) {
    lines.push(`${change.name}: ${change.from} -> ${change.to}`);
  }

  return lines;
}

export async function runPythonRequirementsWildcardUpdate({
  cwd,
  runId,
  requirementsFile = 'requirements.txt'
}) {
  const requirementsPath = path.join(cwd, requirementsFile);
  const originalContent = await fs.readFile(requirementsPath, 'utf8');
  const prepared = prepareWildcardRequirements(originalContent);
  const tempBase = path.join(
    os.tmpdir(),
    `bridge.${String(runId || Date.now()).replace(/[^A-Za-z0-9._-]+/g, '-')}`
  );
  const tempInputPath = `${tempBase}.requirements.in`;
  const resolvedOutputPath = `${tempBase}.resolved.txt`;
  const verifyOutputPath = `${tempBase}.verify.txt`;
  const venvPath = path.join(cwd, '.bridge-venv');
  const venvPython = path.join(venvPath, 'bin', 'python');

  try {
    await fs.writeFile(tempInputPath, prepared.content, 'utf8');
    await fs.rm(venvPath, { recursive: true, force: true });
    await runCommand(`uv venv ${quote(venvPath)}`, { cwd, quiet: true });
    await runCommand(`uv pip compile ${quote(tempInputPath)} -o ${quote(resolvedOutputPath)}`, {
      cwd,
      quiet: true
    });

    const resolvedContent = await fs.readFile(resolvedOutputPath, 'utf8');
    const resolved = buildResolvedRequirementsContent(
      originalContent,
      resolvedContent,
      prepared.updatablePins
    );

    await fs.writeFile(verifyOutputPath, resolved.content, 'utf8');
    await runCommand(`uv pip install --python ${quote(venvPython)} -r ${quote(verifyOutputPath)}`, {
      cwd,
      quiet: true
    });
    await runCommand(`uv pip check --python ${quote(venvPython)}`, {
      cwd,
      quiet: true
    });
    // TODO(verify): run project tests inside the venv once Bridge has a configured test hook.
    await fs.writeFile(requirementsPath, resolved.content, 'utf8');

    return {
      success: true,
      stdout: formatPythonRequirementsSummary({
        changes: resolved.changes,
        skippedZeroMajor: prepared.skippedZeroMajor
      }).join('\n'),
      stderr: '',
      pythonRequirementsSummary: {
        changes: resolved.changes,
        skippedZeroMajor: prepared.skippedZeroMajor,
        transformed: prepared.updatablePins.length,
        passedThrough: prepared.passedThrough
      }
    };
  } finally {
    await fs.rm(venvPath, { recursive: true, force: true });
    await fs.rm(tempInputPath, { force: true });
    await fs.rm(resolvedOutputPath, { force: true });
    await fs.rm(verifyOutputPath, { force: true });
  }
}
