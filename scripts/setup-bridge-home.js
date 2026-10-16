import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!String(process.env.BRIDGE_HOME || '').trim()) {
  process.env.BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-home-'));
}
