import { logActivity } from '../activityLogger.js';
import { redactSensitiveText } from '../redaction.js';
import { formatSecurityDelta, outcomeHeader } from './event.js';
import { recordSlackSend } from './state.js';

export const SLACK_TIMEOUT_MS = 5000;
export const SLACK_RETRY_COUNT = 1;

export function resolveSlackWebhook({ settings, env = process.env, config } = {}) {
  void config;
  const fromEnv =
    typeof env.BRIDGE_SLACK_WEBHOOK_URL === 'string' ? env.BRIDGE_SLACK_WEBHOOK_URL.trim() : '';
  if (fromEnv) {
    return fromEnv;
  }

  const fromSettings = settings?.notifications?.slack?.webhookUrl;
  return typeof fromSettings === 'string' ? fromSettings.trim() : '';
}

function packageLine(packages = {}) {
  return `${packages.direct || 0} direct / ${packages.transitive || 0} trans · ${packages.patch || 0} patch / ${packages.minor || 0} minor / ${packages.major || 0} major`;
}

function repoDigestLine(entry) {
  const header = outcomeHeader({ ...entry, kind: 'run' });
  const pr = entry.prUrl ? ` <${entry.prUrl}|PR>` : '';
  return `• ${entry.repo || 'repo'}  ${header}${pr}`;
}

export function buildSlackPayload(event = {}) {
  const header = outcomeHeader(event);
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: header.slice(0, 150), emoji: true }
    }
  ];

  if (event.kind === 'batch' && Array.isArray(event.repos)) {
    const lines = event.repos.map(repoDigestLine);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: (lines.join('\n') || 'No repos').slice(0, 2900)
      }
    });
  } else {
    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Repo*\n${event.repo || '—'}` },
        { type: 'mrkdwn', text: `*Packages*\n${packageLine(event.packages)}` },
        { type: 'mrkdwn', text: `*Security*\n${formatSecurityDelta(event.security)}` },
        { type: 'mrkdwn', text: `*Base*\n${event.baseBranch || '—'}` }
      ]
    });
  }

  if (event.prUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open PR', emoji: true },
          url: event.prUrl
        }
      ]
    });
  }

  return {
    text: header,
    blocks
  };
}

function errorChainText(error, depth = 0) {
  if (!error || depth > 4) {
    return '';
  }

  const parts = [error.code, error.errno, error.name, error.message];
  if (error.cause) {
    parts.push(errorChainText(error.cause, depth + 1));
  }
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      parts.push(errorChainText(nested, depth + 1));
    }
  }
  return parts.filter(Boolean).join(' ');
}

function failureReason(error) {
  const message = errorChainText(error);
  if (error?.name === 'AbortError' || /aborted|timeout|AbortError/i.test(message)) {
    return 'timed out';
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|bad port/i.test(message)) {
    return 'connection refused';
  }
  return 'request failed';
}

async function postOnce(url, payload, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return { ok: response.ok === true, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendSlackWebhook(
  url,
  payload,
  { fetchImpl = globalThis.fetch, timeoutMs = SLACK_TIMEOUT_MS } = {}
) {
  let lastReason = 'request failed';
  let attempts = 0;
  const maxAttempts = 1 + SLACK_RETRY_COUNT;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    attempts += 1;
    try {
      const result = await postOnce(url, payload, fetchImpl, timeoutMs);
      if (result.ok) {
        return { sent: true, status: result.status, attempts };
      }
      lastReason = `HTTP ${result.status}`;
    } catch (error) {
      lastReason = failureReason(error);
    }
  }

  return { sent: false, reason: lastReason, attempts };
}

export async function deliverSlack(event, options = {}) {
  const { settings, env = process.env, bridgeHome, fetchImpl, timeoutMs } = options;
  const webhookUrl = resolveSlackWebhook({ settings, env });

  if (!webhookUrl) {
    return { sent: false, reason: 'not_configured' };
  }

  const payload = buildSlackPayload(event);
  const result = await sendSlackWebhook(webhookUrl, payload, { fetchImpl, timeoutMs });
  const reason = redactSensitiveText(result.reason || '');

  if (!result.sent) {
    await logActivity('notify_failed', {
      runId: event.runId || '',
      channel: 'slack',
      reason
    });
  }

  try {
    await recordSlackSend(bridgeHome, { ok: result.sent === true, reason });
  } catch {
    // State write must never affect the run.
  }

  return {
    sent: result.sent === true,
    reason: result.sent ? '' : reason,
    attempts: result.attempts
  };
}
