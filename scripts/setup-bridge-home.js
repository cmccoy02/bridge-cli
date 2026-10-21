import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!String(process.env.BRIDGE_HOME || '').trim()) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-home-'));
  process.env.BRIDGE_HOME = home;

  const cleanup = () => {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      // Best-effort: a crashed worker may have already removed the directory.
    }
  };

  process.on('exit', cleanup);
}
