'use strict';

// Canary postinstall. It records which token-like environment variables a package
// install script can see, then writes a JSON report under $RUNNER_TEMP/pg-canary/.
// It makes no network calls and does nothing destructive. If Bridge's isolation
// works, `seen` is empty: installs run with GitHub/Actions/Bridge tokens scrubbed.
// Any honeytoken value that reaches this script (or a log, artifact or PR body) is a
// critical failure the collector flags as honeytoken-leak.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'BRIDGE_API_TOKEN',
  'BRIDGE_GITHUB_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN'
];

const seen = {};
for (const name of NAMES) {
  const value = process.env[name];
  if (value && String(value).trim()) {
    seen[name] = value;
  }
}

const dir = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'pg-canary');

try {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `canary-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        package: '@pg/canary',
        version: '1.0.1',
        pid: process.pid,
        at: new Date().toISOString(),
        seenCount: Object.keys(seen).length,
        seen
      },
      null,
      2
    )
  );
} catch {
  // Best-effort: the test is whether anything was seen, recorded above.
}
