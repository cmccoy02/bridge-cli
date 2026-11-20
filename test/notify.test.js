import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

import { logActivity, makeRunContext } from '../src/core/activityLogger.js';
import { getActivityLogPath } from '../src/core/activityLogger.js';
import { getDailyWrapperPath, runScheduledRepos } from '../src/core/batchRunner.js';
import {
  applyEnvOverrides,
  DEFAULT_SETTINGS,
  getSettingsPath,
  inspectSettingsPermissions,
  loadBridgeSettings
} from '../src/core/bridgeSettings.js';
import { rebuildDailySummary } from '../src/core/dailySummary.js';
import {
  buildNotifyEventFromBatch,
  buildNotifyEventFromReport,
  buildSampleNotifyEvent,
  buildSlackPayload,
  classifyNotifyOutcome,
  dispatchNotify,
  formatSlackDoctorLine,
  formatTerminalLines,
  getSlackDoctorStatus,
  isOutcomeEnabled,
  NOTIFY_SCHEMA,
  notifyFromReport,
  notifyTest,
  outcomeHeader,
  resolveSlackWebhook
} from '../src/core/notify/index.js';
import { buildPullRequestBody } from '../src/core/pullRequest.js';
import { redactSensitiveText } from '../src/core/redaction.js';
import { writeRunReport } from '../src/core/runReport.js';
import { runCommand } from '../src/core/executor.js';

const SLACK_WEBHOOK =
  'https://hooks.slack.com/services/T00000000/B00000000/thisIsAFakeWebhookToken12';
const cliPath = new URL('../bin/bridge.js', import.meta.url).pathname;
const wrapperPath = getDailyWrapperPath();

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Bridge Test',
  GIT_AUTHOR_EMAIL: 'bridge@example.test',
  GIT_COMMITTER_NAME: 'Bridge Test',
  GIT_COMMITTER_EMAIL: 'bridge@example.test'
};

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function makeTempDir(t) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-notify-'));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

async function withBridgeHome(t) {
  const bridgeHome = await makeTempDir(t);
  const previous = process.env.BRIDGE_HOME;
  process.env.BRIDGE_HOME = bridgeHome;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.BRIDGE_HOME;
    } else {
      process.env.BRIDGE_HOME = previous;
    }
  });
  return bridgeHome;
}

async function writeSettings(bridgeHome, settings, mode = 0o600) {
  const filePath = getSettingsPath(bridgeHome);
  await fs.mkdir(bridgeHome, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  return filePath;
}

function emptySecurity() {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
}

function makeReport(overrides = {}) {
  const outcome = overrides.outcome || {};
  const run = overrides.run || {};
  const target = overrides.target || {};
  return {
    schemaVersion: 'bridge-report.v1',
    run: {
      id: 'patch-test-1',
      status: 'pushed',
      durationMs: 1500,
      command: 'patch',
      startedAt: '2026-11-19T19:00:00.000Z',
      ...run
    },
    target: {
      repository: 'acme/app',
      baseBranch: 'main',
      ...target
    },
    git: { baseBranch: 'main' },
    outcome: {
      dependencySummary: {
        totalChanged: 7,
        directChanged: 2,
        transitiveChanged: 5,
        byBump: { patch: 4, minor: 2, major: 1, other: 0 }
      },
      audits: [
        {
          scope: 'root',
          before: { info: 0, low: 0, moderate: 1, high: 2, critical: 1, total: 4 },
          after: { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 }
        }
      ],
      pullRequest: { status: 'created', url: 'https://github.com/acme/app/pull/42' },
      earlyExit: null,
      blockedCount: 0,
      failure: null,
      gateDecisions: [],
      ...outcome
    }
  };
}

function startStub(t, { status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method,
        url: req.url,
        body,
        json: body ? JSON.parse(body) : null
      });
      res.statusCode = typeof status === 'function' ? status(requests.length) : status;
      res.end(res.statusCode === 200 ? 'ok' : 'nope');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      t.after(
        () =>
          new Promise((closeResolve) => {
            server.close(() => closeResolve());
          })
      );
      resolve({
        requests,
        port,
        url: `http://127.0.0.1:${port}/webhook`
      });
    });
  });
}

async function git(cwd, args) {
  return runCommand(`git ${args}`, { cwd, quiet: true, env: gitEnv });
}

async function createOriginRepo(t, name) {
  const root = await makeTempDir(t);
  const originDir = path.join(root, `${name}.git`);
  const seedDir = path.join(root, 'seed');
  await runCommand(`git init --bare --initial-branch=main ${JSON.stringify(originDir)}`, {
    cwd: root,
    quiet: true,
    env: gitEnv
  });
  await fs.mkdir(seedDir);
  await git(seedDir, 'init --initial-branch=main');
  await git(seedDir, 'config user.name "Bridge Test"');
  await git(seedDir, 'config user.email bridge@example.test');
  await git(seedDir, `remote add origin ${JSON.stringify(originDir)}`);
  await fs.writeFile(path.join(seedDir, 'README.md'), `${name}\n`, 'utf8');
  await git(seedDir, 'add README.md');
  await git(seedDir, 'commit -m initial');
  await git(seedDir, 'push -u origin main');
  return { root, originDir };
}

async function writeFakeBridge(binDir, { repoName = 'app', prUrl = '' } = {}) {
  const fake = path.join(binDir, 'bridge');
  const prJson = prUrl
    ? `{"status":"created","url":"${prUrl}"}`
    : 'null';
  await fs.writeFile(
    fake,
    `#!/usr/bin/env bash
set -euo pipefail
echo "fake-bridge $*"
run_id="patch-notify-$$-$RANDOM"
run_dir="\${BRIDGE_HOME}/runs/\${run_id}"
mkdir -p "$run_dir/scripts"
cat > "$run_dir/bridge-summary.md" <<'EOF'
# Bridge after-script summary
NOTIFY
EOF
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$run_dir/bridge-report.v1.json" <<EOF
{"run":{"id":"$run_id","status":"pushed","startedAt":"$started_at","durationMs":12},"target":{"repository":"${repoName}","baseBranch":"main"},"outcome":{"dependencySummary":{"totalChanged":1,"directChanged":1,"transitiveChanged":0,"byBump":{"patch":1,"minor":0,"major":0}},"scriptSummary":{"scripts":[]},"pullRequest":${prJson}}}
EOF
echo "Summary file: $run_dir/bridge-summary.md"
echo "Report: $run_dir/bridge-report.v1.json"
exit 0
`,
    { mode: 0o755 }
  );
  return fake;
}

test('event builder covers created/updated/reused/no_updates/blocked/error', () => {
  const created = buildNotifyEventFromReport(makeReport());
  assert.equal(created.schema, NOTIFY_SCHEMA);
  assert.equal(created.outcome, 'pr_created');
  assert.equal(created.repo, 'acme/app');
  assert.equal(created.baseBranch, 'main');
  assert.equal(created.prUrl, 'https://github.com/acme/app/pull/42');
  assert.equal(created.packages.direct, 2);
  assert.equal(created.packages.transitive, 5);
  assert.equal(created.packages.patch, 4);
  assert.equal(created.packages.minor, 2);
  assert.equal(created.packages.major, 1);
  assert.equal(created.security.before.critical, 1);
  assert.equal(created.security.after.critical, 0);
  assert.equal(created.runId, 'patch-test-1');
  assert.equal(created.durationMs, 1500);
  assert.ok(created.bridgeVersion);

  const updated = buildNotifyEventFromReport(
    makeReport({
      outcome: { pullRequest: { status: 'existing', url: 'https://github.com/acme/app/pull/7' } }
    })
  );
  assert.equal(updated.outcome, 'pr_updated');

  const reused = buildNotifyEventFromReport(
    makeReport({
      outcome: {
        pullRequest: {
          status: 'existing',
          reused: true,
          url: 'https://github.com/acme/app/pull/9'
        }
      }
    })
  );
  assert.equal(reused.outcome, 'pr_reused');
  assert.match(outcomeHeader(reused), /Reused #9/);

  const none = buildNotifyEventFromReport(
    makeReport({
      run: { status: 'up_to_date' },
      outcome: {
        pullRequest: null,
        earlyExit: { code: 'no_updates', message: 'No dependency updates found across all scopes' },
        dependencySummary: {
          totalChanged: 0,
          directChanged: 0,
          transitiveChanged: 0,
          byBump: { patch: 0, minor: 0, major: 0 }
        }
      }
    })
  );
  assert.equal(none.outcome, 'no_updates');

  const blocked = buildNotifyEventFromReport(
    makeReport({
      run: { status: 'failed' },
      outcome: {
        pullRequest: null,
        blockedCount: 1,
        earlyExit: { code: 'audit_block', message: 'New high vulnerabilities' },
        failure: { message: 'New high vulnerabilities' }
      }
    })
  );
  assert.equal(blocked.outcome, 'blocked');
  assert.match(blocked.blockedReason, /high/);

  const errored = buildNotifyEventFromReport(
    makeReport({
      run: { status: 'failed' },
      outcome: {
        pullRequest: null,
        blockedCount: 0,
        earlyExit: null,
        failure: { message: 'Command failed: npm ci' }
      }
    })
  );
  assert.equal(errored.outcome, 'error');
});

test('slack Block Kit payloads match each outcome', () => {
  const cases = [
    ['pr_created', makeReport(), /PR opened/, true],
    [
      'pr_updated',
      makeReport({
        outcome: { pullRequest: { status: 'updated', url: 'https://github.com/acme/app/pull/3' } }
      }),
      /PR updated/,
      true
    ],
    [
      'pr_reused',
      makeReport({
        outcome: {
          pullRequest: {
            status: 'existing',
            reused: true,
            url: 'https://github.com/acme/app/pull/11'
          }
        }
      }),
      /Reused #11/,
      true
    ],
    [
      'no_updates',
      makeReport({
        run: { status: 'up_to_date' },
        outcome: { pullRequest: null, earlyExit: { code: 'no_updates' } }
      }),
      /No updates/,
      false
    ],
    [
      'blocked',
      makeReport({
        run: { status: 'failed' },
        outcome: {
          pullRequest: null,
          blockedCount: 1,
          earlyExit: { code: 'validation_block', message: 'NEW after-script failure' }
        }
      }),
      /Blocked/,
      false
    ],
    [
      'error',
      makeReport({
        run: { status: 'failed' },
        outcome: { pullRequest: null, failure: { message: 'boom' } }
      }),
      /Error/,
      false
    ]
  ];

  for (const [name, report, header, hasButton] of cases) {
    const event = buildNotifyEventFromReport(report);
    assert.equal(event.outcome, name);
    const payload = buildSlackPayload(event);
    assert.equal(payload.blocks[0].type, 'header');
    assert.match(payload.blocks[0].text.text, header);
    const packageSection = JSON.stringify(payload.blocks);
    assert.match(packageSection, /2 direct/);
    const button = payload.blocks.find((block) => block.type === 'actions');
    if (hasButton) {
      assert.equal(button.elements[0].text.text, 'Open PR');
      assert.ok(button.elements[0].url.startsWith('https://github.com/'));
    } else {
      assert.equal(button, undefined);
    }
  }
});

test('heartbeat outcomes are off by default and can be turned on', async (t) => {
  const stub = await startStub(t);
  const reused = buildNotifyEventFromReport(
    makeReport({
      outcome: {
        pullRequest: {
          status: 'existing',
          reused: true,
          url: 'https://github.com/acme/app/pull/4'
        }
      }
    })
  );
  const idle = buildNotifyEventFromReport(
    makeReport({
      run: { status: 'up_to_date' },
      outcome: { pullRequest: null, earlyExit: { code: 'no_updates' } }
    })
  );

  assert.equal(isOutcomeEnabled('pr_reused', DEFAULT_SETTINGS), false);
  assert.equal(isOutcomeEnabled('no_updates', DEFAULT_SETTINGS), false);
  assert.equal(isOutcomeEnabled('pr_created', DEFAULT_SETTINGS), true);

  const off = await dispatchNotify(reused, {
    env: { BRIDGE_SLACK_WEBHOOK_URL: stub.url },
    skipTerminal: true,
    skipCommand: true
  });
  assert.equal(off.slack.sent, false);
  assert.equal(off.slack.reason, 'filtered');
  assert.equal(stub.requests.length, 0);

  await dispatchNotify(idle, {
    env: { BRIDGE_SLACK_WEBHOOK_URL: stub.url },
    skipTerminal: true,
    skipCommand: true
  });
  assert.equal(stub.requests.length, 0);

  const settings = applyEnvOverrides({
    notifications: {
      on: ['pr_created', 'pr_updated', 'pr_reused', 'no_updates', 'blocked', 'error']
    }
  });
  await dispatchNotify(reused, {
    env: { BRIDGE_SLACK_WEBHOOK_URL: stub.url },
    settings,
    skipTerminal: true,
    skipCommand: true
  });
  await dispatchNotify(idle, {
    env: { BRIDGE_SLACK_WEBHOOK_URL: stub.url },
    settings,
    skipTerminal: true,
    skipCommand: true
  });
  assert.equal(stub.requests.length, 2);
});

test('webhook 404 retries once, logs notify_failed, and does not throw', async (t) => {
  const bridgeHome = await withBridgeHome(t);
  const stub = await startStub(t, { status: 404 });
  const event = buildNotifyEventFromReport(makeReport(), { reportPath: '/tmp/report.json' });

  const result = await dispatchNotify(event, {
    env: { BRIDGE_HOME: bridgeHome, BRIDGE_SLACK_WEBHOOK_URL: stub.url },
    bridgeHome,
    skipTerminal: true,
    skipCommand: true
  });

  assert.equal(result.slack.sent, false);
  assert.match(result.slack.reason, /HTTP 404/);
  assert.equal(stub.requests.length, 2);
  const log = await fs.readFile(getActivityLogPath(bridgeHome), 'utf8');
  assert.match(log, /notify_failed/);
  assert.doesNotMatch(log, /127\.0\.0\.1/);
  const status = await getSlackDoctorStatus({
    bridgeHome,
    env: { BRIDGE_SLACK_WEBHOOK_URL: stub.url }
  });
  assert.equal(status.line, 'Slack: last send failed');
});

test('connection refused leaves the run unaffected and logs notify_failed', async (t) => {
  const bridgeHome = await withBridgeHome(t);
  const closedPort = await new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const event = buildNotifyEventFromReport(makeReport());
  const result = await dispatchNotify(event, {
    env: {
      BRIDGE_HOME: bridgeHome,
      BRIDGE_SLACK_WEBHOOK_URL: `http://127.0.0.1:${closedPort}/webhook`
    },
    bridgeHome,
    skipTerminal: true,
    skipCommand: true
  });

  assert.equal(result.slack.sent, false);
  assert.match(result.slack.reason, /connection refused/i);
  const log = await fs.readFile(getActivityLogPath(bridgeHome), 'utf8');
  assert.match(log, /notify_failed/);
  assert.doesNotMatch(log, /thisIsAFakeWebhookToken12/);
  assert.doesNotMatch(log, /127\.0\.0\.1/);
});

test('slack webhook URL never appears in operations.log, run reports, LATEST.md, or PR bodies', async (t) => {
  const bridgeHome = await withBridgeHome(t);
  const run = makeRunContext('patch', '/tmp/secret-project');
  await logActivity('run_error', {
    runId: run.runId,
    error: `webhook ${SLACK_WEBHOOK} failed`,
    command: `curl ${SLACK_WEBHOOK}`
  });

  const { report, reportPath } = await writeRunReport({
    run,
    status: 'failed',
    repo: 'secret-project',
    failure: {
      message: `notify failed: ${SLACK_WEBHOOK}`,
      command: `curl -X POST ${SLACK_WEBHOOK}`,
      stderr: `posting to ${SLACK_WEBHOOK}`
    }
  });

  const daily = await rebuildDailySummary({ bridgeHome });
  const prBody = buildPullRequestBody({
    branchName: 'bridge/patch-test',
    baseBranch: 'main',
    dependencySummary: { directChanged: 1, transitiveChanged: 0, byBump: { patch: 1 } },
    dependencyDeltas: [],
    auditResults: [],
    validationResults: [],
    runReportPath: SLACK_WEBHOOK,
    bridgeVersion: '0.1.0'
  });

  await dispatchNotify(buildNotifyEventFromReport(report, { reportPath }), {
    env: { BRIDGE_HOME: bridgeHome, BRIDGE_SLACK_WEBHOOK_URL: SLACK_WEBHOOK },
    bridgeHome,
    skipTerminal: true,
    skipCommand: true,
    fetchImpl: async (url) => {
      throw new Error(`getaddrinfo ENOTFOUND ${url}`);
    }
  });

  const operations = await fs.readFile(getActivityLogPath(bridgeHome), 'utf8');
  const savedReport = await fs.readFile(reportPath, 'utf8');
  const latest = await fs.readFile(daily.latestPath, 'utf8');
  const artifacts = [operations, savedReport, latest, prBody, redactSensitiveText(SLACK_WEBHOOK)];

  for (const text of artifacts) {
    assert.doesNotMatch(text, /thisIsAFakeWebhookToken12/);
    assert.doesNotMatch(text, /T00000000\/B00000000/);
  }

  assert.match(redactSensitiveText(`x ${SLACK_WEBHOOK} y`), /hooks\.slack\.com\/services\/\[redacted\]/);
});

test('settings.json mode wider than 0600 is warned and webhook is not read from repo config', async (t) => {
  const bridgeHome = await withBridgeHome(t);
  await writeSettings(
    bridgeHome,
    { notifications: { slack: { webhookUrl: 'http://127.0.0.1:9/from-settings' } } },
    0o644
  );
  const inspection = await inspectSettingsPermissions(bridgeHome);
  assert.equal(inspection.tooOpen, true);
  assert.match(inspection.warning, /chmod 600/);
  assert.doesNotMatch(inspection.warning, /127\.0\.0\.1/);

  const loaded = await loadBridgeSettings({
    bridgeHome,
    env: { BRIDGE_HOME: bridgeHome }
  });
  assert.equal(loaded.notifications.slack.webhookUrl, 'http://127.0.0.1:9/from-settings');

  const fromEnv = resolveSlackWebhook({
    settings: loaded,
    env: { BRIDGE_SLACK_WEBHOOK_URL: 'http://127.0.0.1:9/from-env' },
    config: {
      notifications: { slack: { webhookUrl: SLACK_WEBHOOK } },
      slack: { webhookUrl: SLACK_WEBHOOK }
    }
  });
  assert.equal(fromEnv, 'http://127.0.0.1:9/from-env');

  const fromSettingsOnly = resolveSlackWebhook({
    settings: loaded,
    env: {},
    config: { notifications: { slack: { webhookUrl: SLACK_WEBHOOK } } }
  });
  assert.equal(fromSettingsOnly, 'http://127.0.0.1:9/from-settings');
  assert.doesNotMatch(fromSettingsOnly, /hooks\.slack\.com/);

  const ignored = resolveSlackWebhook({
    settings: DEFAULT_SETTINGS,
    env: {},
    config: { notifications: { slack: { webhookUrl: SLACK_WEBHOOK } } }
  });
  assert.equal(ignored, '');
});

test('batch digest posts exactly once with one line per repo', async (t) => {
  const stub = await startStub(t);
  const first = await createOriginRepo(t, 'alpha');
  const second = await createOriginRepo(t, 'beta');
  const bridgeHome = path.join(first.root, 'bridge-home');
  const binDir = path.join(first.root, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeBridge = await writeFakeBridge(binDir, {
    repoName: 'alpha',
    prUrl: 'https://github.com/acme/alpha/pull/2'
  });
  await writeFakeBridge(binDir, {
    repoName: 'beta',
    prUrl: 'https://github.com/acme/beta/pull/3'
  });

  const env = {
    ...gitEnv,
    BRIDGE_HOME: bridgeHome,
    PATH: `${binDir}:${process.env.PATH}`,
    BRIDGE_BIN: fakeBridge,
    BRIDGE_SLACK_WEBHOOK_URL: stub.url
  };

  const batch = await runScheduledRepos({
    repos: [{ repo: first.originDir }, { repo: second.originDir }],
    concurrency: 2,
    dryRun: true,
    skipBeforeScripts: true,
    env,
    cwd: first.root,
    wrapperPath,
    bridgeHome
  });

  assert.equal(batch.ok, true, JSON.stringify(batch.results, null, 2));
  assert.equal(stub.requests.length, 1, 'batch sends exactly one Slack POST');
  const payload = stub.requests[0].json;
  const serialized = JSON.stringify(payload);
  assert.match(serialized, /alpha|beta/);
  assert.equal(payload.blocks[0].type, 'header');

  const member = await notifyFromReport({
    report: makeReport({ run: { batchId: batch.batchId } }),
    env: { ...env, BRIDGE_BATCH_ID: batch.batchId },
    bridgeHome,
    skipTerminal: true,
    skipCommand: true
  });
  assert.equal(member.reason, 'batch_member');
  assert.equal(stub.requests.length, 1);
});

test('terminal result card lists outcome, PR, counts, security delta, and report path', () => {
  const event = buildNotifyEventFromReport(makeReport(), {
    reportPath: '/tmp/bridge-home/runs/patch-test-1/bridge-report.v1.json'
  });
  const lines = formatTerminalLines(event).join('\n');
  assert.match(lines, /PR opened/);
  assert.match(lines, /https:\/\/github.com\/acme\/app\/pull\/42/);
  assert.match(lines, /2 direct/);
  assert.match(lines, /5 trans/);
  assert.match(lines, /4 → 2|4 -> 2|total 4/);
  assert.match(lines, /bridge-report\.v1\.json/);
});

test('doctor slack line never prints the webhook URL', async (t) => {
  const bridgeHome = await withBridgeHome(t);
  const empty = await getSlackDoctorStatus({ bridgeHome, env: {} });
  assert.equal(empty.line, 'Slack: not configured');
  assert.equal(formatSlackDoctorLine({ configured: true, lastFailed: false }), 'Slack: configured');
  assert.equal(
    formatSlackDoctorLine({ configured: true, lastFailed: true }),
    'Slack: last send failed'
  );

  await writeSettings(bridgeHome, {
    notifications: { slack: { webhookUrl: SLACK_WEBHOOK } }
  });
  const configured = await getSlackDoctorStatus({ bridgeHome, env: { BRIDGE_HOME: bridgeHome } });
  assert.equal(configured.line, 'Slack: configured');
  assert.doesNotMatch(JSON.stringify(configured), /thisIsAFakeWebhookToken12/);
  assert.doesNotMatch(configured.line, /hooks\.slack\.com/);
});

test('bridge notify test reports per-channel ok/fail and never prints the URL', async (t) => {
  const stub = await startStub(t, { status: 404 });
  const bridgeHome = await withBridgeHome(t);
  const output = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, 'notify', 'test'], {
      env: {
        ...process.env,
        BRIDGE_HOME: bridgeHome,
        BRIDGE_SLACK_WEBHOOK_URL: stub.url
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /terminal\s+ok/i);
  assert.match(output.stdout, /slack\s+fail/i);
  assert.doesNotMatch(`${output.stdout}\n${output.stderr}`, /127\.0\.0\.1/);
  assert.doesNotMatch(`${output.stdout}\n${output.stderr}`, /hooks\.slack\.com/);
  assert.ok(stub.requests.length >= 1);
});

test('notify test sample uses the v1 schema', () => {
  const sample = buildSampleNotifyEvent();
  assert.equal(sample.schema, NOTIFY_SCHEMA);
  assert.equal(sample.kind, 'test');
  assert.equal(sample.outcome, 'pr_created');
  assert.equal(classifyNotifyOutcome(makeReport()), 'pr_created');
});

test('batch event is one digest line per repo', () => {
  const event = buildNotifyEventFromBatch({
    daily: {
      latestPath: '/tmp/LATEST.md',
      text: 'Bridge daily summary',
      model: {
        batch: { id: 'batch-1' },
        totals: { wallMs: 4000 },
        repos: [
          {
            repo: 'alpha',
            status: 'pushed',
            prAction: 'created',
            prUrl: 'https://github.com/acme/alpha/pull/2',
            packagesUpdated: 1,
            durationMs: 1000
          },
          {
            repo: 'beta',
            status: 'failed',
            prAction: 'none',
            prUrl: '',
            failureReason: 'audit block',
            packagesUpdated: 0,
            durationMs: 800
          }
        ]
      }
    }
  });
  assert.equal(event.kind, 'batch');
  assert.equal(event.repos.length, 2);
  const payload = buildSlackPayload(event);
  const text = JSON.stringify(payload);
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
  assert.equal(payload.blocks.filter((block) => block.type === 'header').length, 1);
});
