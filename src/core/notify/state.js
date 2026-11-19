import fs from 'node:fs/promises';
import path from 'node:path';

import { getBridgeHome } from '../bridgeHome.js';
import { redactSensitiveText } from '../redaction.js';

export function getNotifyStatePath(bridgeHome = getBridgeHome()) {
  return path.join(bridgeHome, 'notify-state.json');
}

export async function loadNotifyState(bridgeHome = getBridgeHome()) {
  try {
    const raw = JSON.parse(await fs.readFile(getNotifyStatePath(bridgeHome), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export async function recordSlackSend(bridgeHome = getBridgeHome(), { ok, reason } = {}) {
  const current = await loadNotifyState(bridgeHome);
  const next = {
    ...current,
    slack: {
      lastOk: ok === true,
      lastAt: new Date().toISOString(),
      lastReason: redactSensitiveText(reason || '')
    }
  };
  await fs.mkdir(bridgeHome, { recursive: true });
  await fs.writeFile(
    getNotifyStatePath(bridgeHome),
    `${JSON.stringify(next, null, 2)}\n`,
    { mode: 0o600 }
  );
  return next;
}
