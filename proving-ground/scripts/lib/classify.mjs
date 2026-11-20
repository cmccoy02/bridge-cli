// Rules-first failure classification. Every run that did not end as expected is put
// in exactly one category; the raw excerpt travels with it so an agent can
// re-classify an `unknown`. Keep the ordering: the first matching rule wins, and the
// most specific/severe signals come first.

export const FAILURE_CATEGORIES = [
  'install',
  'registry-auth',
  'network',
  'peer-conflict',
  'engine',
  'checks-new-failure',
  'checks-flaky',
  'cooldown',
  'audit',
  'timeout',
  'workflow-config',
  'unsupported',
  'bridge-crash',
  'publish',
  'honeytoken-leak',
  'unknown'
];

const GATE_CATEGORY = {
  cooldown_block: 'cooldown',
  validation_block: 'checks-new-failure',
  audit_block: 'audit'
};

// Ordered [category, test]. `ctx` carries { text, gate, status, publishFailed }.
const RULES = [
  ['workflow-config', (ctx) => /localhost:4873|mock registry|setup-registry|verdaccio|could not start the registry/i.test(ctx.text)],
  ['peer-conflict', (ctx) => /ERESOLVE|peer dep|peerdependenc|unable to resolve dependency tree/i.test(ctx.text)],
  ['unsupported', (ctx) => /unsupported package manager|no bridge preset|unknown package manager|could not detect a package manager|ecosystem is not supported/i.test(ctx.text)],
  ['engine', (ctx) => /EBADENGINE|unsupported engine|requires node|incompatible node/i.test(ctx.text)],
  ['registry-auth', (ctx) => /\bE401\b|\bE403\b|\b401 Unauthorized\b|\b403 Forbidden\b|authentication token|unauthorized|need auth/i.test(ctx.text)],
  ['network', (ctx) => /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|getaddrinfo|socket hang up|network timeout|request to .* failed/i.test(ctx.text)],
  ['install', (ctx) => /ENOSPC|EACCES|npm ERR!\s|failed to install|installation failed|could not install|pip .*error: |poetry\.lock .*outdated|mix deps\.get .*failed/i.test(ctx.text)],
  ['timeout', (ctx) => ctx.status === 'cancelled' || /timed out|execution was cancelled|exceeded the .* timeout|the job running on runner .* has exceeded/i.test(ctx.text)],
  ['bridge-crash', (ctx) => !ctx.gate && /TypeError|ReferenceError|is not a function|is not defined|Cannot read properties of|SyntaxError|UnhandledPromiseRejection/.test(ctx.text)]
];

function collectText(parts) {
  return parts
    .filter((part) => typeof part === 'string' && part.trim())
    .join('\n')
    .slice(0, 8000);
}

/**
 * Classifies a run into one failure category, or returns null when the run looks like
 * an expected success (a PR opened / up to date with nothing to explain).
 *
 * @param {object} args
 * @param {object|null} args.report  The Bridge run report (final or v1).
 * @param {string} [args.logsText]   Concatenated raw logs for pattern matching.
 * @param {string} args.status       The derived actual status.
 * @param {number} [args.honeytokenLeaks]
 */
export function classifyRun({ report = null, logsText = '', status, honeytokenLeaks = 0 }) {
  if (honeytokenLeaks > 0) {
    return { category: 'honeytoken-leak', excerpt: `honeytoken sightings: ${honeytokenLeaks}`, classifiedBy: 'rules' };
  }

  const gate = report?.outcome?.earlyExit?.code || report?.outcome?.failure?.gateType || '';
  const publishFailed = report?.publish?.status === 'failed';
  const failure = report?.outcome?.failure || null;
  const text = collectText([
    failure?.message,
    failure?.stderr,
    failure?.stdout,
    report?.publish?.message,
    logsText
  ]);

  // Nothing went wrong: a clean PR / up-to-date / unchanged run needs no category.
  const benign = ['pr_opened', 'pr_updated', 'pr_unchanged', 'up_to_date'];
  if (benign.includes(status) && !publishFailed && !gate) {
    return null;
  }

  if (publishFailed) {
    return { category: 'publish', excerpt: collectText([report?.publish?.message, text]).slice(0, 1500), classifiedBy: 'rules' };
  }

  const ctx = { text, gate, status, publishFailed };

  for (const [category, test] of RULES) {
    if (test(ctx)) {
      return { category, excerpt: text.slice(0, 1500), classifiedBy: 'rules' };
    }
  }

  if (GATE_CATEGORY[gate]) {
    return { category: GATE_CATEGORY[gate], excerpt: text.slice(0, 1500) || gate, classifiedBy: 'rules' };
  }

  // A policy block that is not a peer conflict (e.g. a blocked major) has no dedicated
  // category yet; leave it for an agent rather than forcing a wrong label.
  return { category: 'unknown', excerpt: text.slice(0, 1500) || `status=${status} gate=${gate || 'none'}`, classifiedBy: 'rules' };
}
