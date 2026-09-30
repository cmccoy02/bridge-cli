/**
 * Combine and normalize command stdout/stderr for comparison and display.
 *
 * Package managers often put a command echo on stderr (`$ eslint .`) and the
 * real findings on stdout. Callers must never use `stderr || stdout`.
 */

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const TEMP_WORKSPACE_RE = /\/(?:tmp|var\/folders)\/[^\s:'"]*bridge-[^\s:'"]+/gi;
const ABS_TMP_RE = /(?:\/(?:tmp|private\/tmp|var\/folders)\/[^\s:'"]+)/g;
const DURATION_RE = /\b\d+(?:\.\d+)?\s*(?:ms|s|m|sec|secs|seconds|minutes)\b/gi;

export function combineCommandStreams(stdout, stderr) {
  const out = String(stdout || '');
  const err = String(stderr || '');

  if (out && err) {
    return `${err}\n${out}`;
  }

  return out || err;
}

export function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

export function normalizeFailureText(text) {
  return stripAnsi(text)
    .replace(TEMP_WORKSPACE_RE, '<workspace>')
    .replace(ABS_TMP_RE, '<tmp>')
    .replace(DURATION_RE, '<time>')
    .replace(/\r\n/g, '\n');
}

function isNoiseLine(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return true;
  }

  // pnpm/npm/yarn command echoes, not the actual failure
  if (/^\$\s+\S/.test(trimmed)) {
    return true;
  }

  if (/^>\s+\S/.test(trimmed) && trimmed.length < 100) {
    return true;
  }

  if (/^TAP version/i.test(trimmed)) {
    return true;
  }

  if (/^\d+\.\.\d+$/.test(trimmed)) {
    return true;
  }

  if (/^#\s*(tests|pass|fail|skipped|todo|duration)/i.test(trimmed)) {
    return true;
  }

  if (/^ok\s+\d+/i.test(trimmed)) {
    return true;
  }

  if (/^npm\s+notice/i.test(trimmed)) {
    return true;
  }

  return false;
}

export function extractNormalizedErrorLines(text) {
  const normalized = normalizeFailureText(text);
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isNoiseLine(line));

  return [...new Set(lines)];
}

export function newErrorLines(beforeText, afterText) {
  const before = new Set(extractNormalizedErrorLines(beforeText));
  return extractNormalizedErrorLines(afterText).filter((line) => !before.has(line));
}

export function failureOutputChanged(beforeText, afterText) {
  const added = newErrorLines(beforeText, afterText);

  if (added.length > 0) {
    return { changed: true, added, conservative: false };
  }

  const beforeLines = extractNormalizedErrorLines(beforeText);
  const afterLines = extractNormalizedErrorLines(afterText);

  // No structured error lines on either side: fall back to normalized full text.
  // If that still differs, treat it as a new failure (conservative).
  if (beforeLines.length === 0 && afterLines.length === 0) {
    const beforeNorm = normalizeFailureText(beforeText).trim();
    const afterNorm = normalizeFailureText(afterText).trim();

    if (beforeNorm !== afterNorm) {
      return { changed: true, added: [], conservative: true };
    }
  }

  return { changed: false, added: [], conservative: false };
}

export function extractFailingExcerpt(
  stdout,
  stderr,
  { maxLines = 16, maxChars = 1200 } = {}
) {
  const combined = combineCommandStreams(stdout, stderr);
  const cleaned = stripAnsi(combined);

  if (!cleaned.trim()) {
    return '';
  }

  const lines = cleaned.split(/\n/);
  const interesting = lines.filter((line) => {
    const trimmed = line.trim();

    if (!trimmed || /^\$\s+\S/.test(trimmed)) {
      return false;
    }

    return (
      /error|fail|✖|×|not ok\b|AssertionError|ELIFECYCLE|ENOENT|TS\d+|ERR!|Code style issues|warning|NEW_ERROR|FAIL -/i.test(
        trimmed
      ) ||
      /\.(?:js|ts|tsx|jsx|mjs|cjs|json|d\.ts)\b/.test(trimmed) ||
      /^\s+\d+:\d+/.test(trimmed)
    );
  });

  const selected =
    interesting.length > 0
      ? interesting.slice(-maxLines)
      : lines.filter((line) => line.trim() && !/^\$\s+\S/.test(line.trim())).slice(-maxLines);

  let text = selected.join('\n').trim();

  if (text.length > maxChars) {
    text = `... [truncated]\n${text.slice(-maxChars)}`;
  }

  return text;
}

export function outputFromResult(result) {
  if (!result) {
    return '';
  }

  return combineCommandStreams(result.stdout, result.stderr);
}
