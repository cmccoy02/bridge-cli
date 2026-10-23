import os from 'node:os';
import path from 'node:path';

export function getBridgeHome() {
  const configured = String(process.env.BRIDGE_HOME || '').trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.bridge');
}
