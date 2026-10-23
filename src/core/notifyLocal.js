import { spawn } from 'node:child_process';

import { loadBridgeSettings } from './bridgeSettings.js';

function runDetached(command, { env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      env,
      shell: true,
      stdio: 'ignore'
    });

    child.on('error', () => resolve({ success: false }));
    child.on('close', (code) => resolve({ success: code === 0, code }));
  });
}

function quoteAppleScript(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

export function defaultNotifyCommand(platform = process.platform) {
  if (platform === 'darwin') {
    return 'osascript -e "display notification \\"$BRIDGE_NOTIFY_BODY\\" with title \\"$BRIDGE_NOTIFY_TITLE\\""';
  }

  return '';
}

export function buildNotifyPayload(summaryText = '', { title = 'Bridge' } = {}) {
  const lines = String(summaryText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headline = lines[0] || title;
  const repos = lines.find((line) => line.startsWith('Repos:')) || '';
  const failure = lines.find((line) => line.startsWith('Failure:') || /  failed  /.test(line));
  const body = [repos, failure].filter(Boolean).join(' · ') || headline;

  return {
    title,
    body: body.slice(0, 180),
    headline
  };
}

export async function notifyDailySummary({
  summaryText = '',
  summaryPath = '',
  enabled,
  notifyCommand,
  bridgeHome,
  env = process.env,
  platform = process.platform
} = {}) {
  const settings = await loadBridgeSettings({ bridgeHome, env });
  const shouldNotify =
    enabled === true || (enabled !== false && (settings.notify || Boolean(settings.notifyCommand)));

  if (!shouldNotify) {
    return { sent: false, reason: 'disabled' };
  }

  const payload = buildNotifyPayload(summaryText);
  const command =
    (typeof notifyCommand === 'string' && notifyCommand.trim()) ||
    settings.notifyCommand ||
    defaultNotifyCommand(platform);

  if (!command) {
    return { sent: false, reason: 'no_command', payload };
  }

  const result = await runDetached(command, {
    env: {
      ...env,
      BRIDGE_NOTIFY_TITLE: payload.title,
      BRIDGE_NOTIFY_BODY: payload.body,
      BRIDGE_SUMMARY_PATH: summaryPath,
      BRIDGE_SUMMARY_TEXT: summaryText
    }
  });

  return {
    sent: result.success === true,
    command,
    payload
  };
}

export function formatOsascriptNotification(title, body) {
  return `osascript -e "display notification \\"${quoteAppleScript(body)}\\" with title \\"${quoteAppleScript(title)}\\""`;
}
