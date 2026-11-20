import fs from 'node:fs/promises';
import path from 'node:path';

import { getBridgeHome } from './bridgeHome.js';

export const SETTINGS_FILE_NAME = 'settings.json';

export const DEFAULT_NOTIFY_ON = ['pr_created', 'pr_updated', 'blocked', 'error'];

export const DEFAULT_SETTINGS = {
  retention: {
    maxAgeDays: 30,
    maxRuns: 100,
    maxLogBytes: 10 * 1024 * 1024
  },
  concurrency: 2,
  notify: false,
  notifyCommand: '',
  notifications: {
    on: [...DEFAULT_NOTIFY_ON],
    slack: {
      webhookUrl: ''
    }
  }
};

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value === true || value === false) {
    return value;
  }

  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function mergeNotifications(base = DEFAULT_SETTINGS.notifications, override = {}) {
  const source = override && typeof override === 'object' ? override : {};
  return {
    on: Array.isArray(source.on)
      ? [...new Set(source.on.map((value) => String(value)))]
      : [...(base.on || DEFAULT_NOTIFY_ON)],
    slack: {
      webhookUrl:
        typeof source.slack?.webhookUrl === 'string'
          ? source.slack.webhookUrl.trim()
          : base.slack?.webhookUrl || ''
    }
  };
}

function mergeSettings(base, override = {}) {
  return {
    ...base,
    ...override,
    retention: {
      ...base.retention,
      ...(override.retention || {})
    },
    notifications: mergeNotifications(base.notifications, override.notifications)
  };
}

export function getSettingsPath(bridgeHome = getBridgeHome()) {
  return path.join(bridgeHome, SETTINGS_FILE_NAME);
}

export async function readSettingsFile(bridgeHome = getBridgeHome()) {
  try {
    const raw = JSON.parse(await fs.readFile(getSettingsPath(bridgeHome), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {};
    }

    return {};
  }
}

export function applyEnvOverrides(settings, env = process.env) {
  const next = mergeSettings(DEFAULT_SETTINGS, settings);
  const retention = { ...next.retention };

  if (env.BRIDGE_RETENTION_DAYS) {
    retention.maxAgeDays = toPositiveInt(env.BRIDGE_RETENTION_DAYS, retention.maxAgeDays);
  }

  if (env.BRIDGE_RETENTION_MAX_RUNS) {
    retention.maxRuns = toPositiveInt(env.BRIDGE_RETENTION_MAX_RUNS, retention.maxRuns);
  }

  if (env.BRIDGE_RETENTION_MAX_LOG_BYTES) {
    retention.maxLogBytes = toPositiveInt(
      env.BRIDGE_RETENTION_MAX_LOG_BYTES,
      retention.maxLogBytes
    );
  }

  const notifications = mergeNotifications(next.notifications, next.notifications);
  if (typeof env.BRIDGE_SLACK_WEBHOOK_URL === 'string' && env.BRIDGE_SLACK_WEBHOOK_URL.trim()) {
    notifications.slack = {
      ...notifications.slack,
      webhookUrl: env.BRIDGE_SLACK_WEBHOOK_URL.trim()
    };
  }

  return {
    ...next,
    retention,
    notifications,
    concurrency: toPositiveInt(env.BRIDGE_CONCURRENCY, next.concurrency),
    notify: toBoolean(env.BRIDGE_NOTIFY, next.notify),
    notifyCommand:
      typeof env.BRIDGE_NOTIFY_COMMAND === 'string' && env.BRIDGE_NOTIFY_COMMAND.trim()
        ? env.BRIDGE_NOTIFY_COMMAND.trim()
        : next.notifyCommand || ''
  };
}

export async function inspectSettingsPermissions(bridgeHome = getBridgeHome()) {
  try {
    const filePath = getSettingsPath(bridgeHome);
    const stat = await fs.stat(filePath);
    const mode = stat.mode & 0o777;
    const tooOpen = (stat.mode & 0o077) !== 0;
    return {
      exists: true,
      path: filePath,
      mode,
      tooOpen,
      warning: tooOpen
        ? `${filePath} is readable by others (mode ${mode.toString(8).padStart(3, '0')}); chmod 600 recommended.`
        : ''
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, path: getSettingsPath(bridgeHome), mode: 0, tooOpen: false, warning: '' };
    }

    return { exists: false, path: getSettingsPath(bridgeHome), mode: 0, tooOpen: false, warning: '' };
  }
}

export async function loadBridgeSettings({
  bridgeHome = getBridgeHome(),
  env = process.env
} = {}) {
  const fileSettings = await readSettingsFile(bridgeHome);
  return applyEnvOverrides(mergeSettings(DEFAULT_SETTINGS, fileSettings), env);
}
