import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkReleaseAgeCooldown, resolveNativeCooldown } from '../src/core/cooldown.js';
import { makeRunContext } from '../src/core/activityLogger.js';
import { writeRunReport } from '../src/core/runReport.js';
import { writeHandoffOutcome } from '../src/core/handoff.js';
import { publishCommand } from '../src/commands/publish.js';

const DAY_MS = 24 * 60 * 60 * 1000;

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('resolveNativeCooldown time machine: npm/pnpm/yarn use before = asOf - cooldown', async () => {
  const asOf = '2025-06-01T00:00:00.000Z';
  const expectedBefore = new Date(Date.parse(asOf) - 3 * DAY_MS).toISOString();

  for (const manager of ['npm', 'pnpm', 'yarn']) {
    const native = await resolveNativeCooldown({ packageManager: manager, days: 3, asOf });
    assert.equal(native.applied, true, `${manager} should apply a native cutoff`);
    assert.equal(native.asOfSupported, true, `${manager} supports as-of`);
    assert.equal(native.setting, 'before');
    assert.equal(native.env.npm_config_before, expectedBefore);
    assert.equal(native.asOf, asOf);
    // The time machine must never also set a relative release-age gate (npm rejects both).
    assert.equal(native.env.npm_config_min_release_age, undefined);
    assert.equal(native.env.npm_config_minimum_release_age, undefined);
  }
});

test('resolveNativeCooldown time machine: uv uses exclude-newer at the exact asOf', async () => {
  const asOf = '2025-06-01T00:00:00.000Z';
  const native = await resolveNativeCooldown({ packageManager: 'uv', days: 3, asOf });
  assert.equal(native.applied, true);
  assert.equal(native.asOfSupported, true);
  assert.equal(native.setting, 'exclude-newer');
  assert.equal(native.env.UV_EXCLUDE_NEWER, asOf);
  assert.equal(native.env.npm_config_before, undefined);
});

test('resolveNativeCooldown time machine: unsupported managers run live', async () => {
  const asOf = '2025-06-01T00:00:00.000Z';
  const native = await resolveNativeCooldown({ packageManager: 'mix', days: 3, asOf });
  assert.equal(native.applied, false);
  assert.equal(native.asOfSupported, false);
  assert.deepEqual(native.env, {});
  assert.equal(native.asOf, asOf);
});

test('checkReleaseAgeCooldown treats now = asOf so the window is measured from the as-of date', async () => {
  const publishedAt = '2025-01-01T00:00:00.000Z';
  const fetchImpl = async () =>
    new Response(JSON.stringify({ time: { '1.0.0': publishedAt } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  const deltas = [{ name: 'foo', from: '0.9.0', to: '1.0.0', kind: 'direct', bump: 'minor' }];

  // As of nine days after publish, a 3-day cooldown is satisfied.
  const settled = await checkReleaseAgeCooldown({
    deltas,
    lockfileFormat: 'json-npm',
    days: 3,
    now: Date.parse('2025-01-10T00:00:00.000Z'),
    fetchImpl
  });
  assert.equal(settled.violations.length, 0);
  assert.equal(settled.passed, 1);

  // As of one day after publish, the same version is still inside the cooldown window.
  const tooNew = await checkReleaseAgeCooldown({
    deltas,
    lockfileFormat: 'json-npm',
    days: 3,
    now: Date.parse('2025-01-02T00:00:00.000Z'),
    fetchImpl
  });
  assert.equal(tooNew.violations.length, 1);
  assert.equal(tooNew.violations[0].name, 'foo');
});

test('writeRunReport records run.asOf and report.experiment', async () => {
  const run = makeRunContext('patch', '/tmp/example');
  const { report } = await writeRunReport({
    run,
    status: 'up_to_date',
    repo: 'example',
    asOf: '2025-06-01T00:00:00.000Z',
    experiment: { id: 'daily-2025-06-01', fixtureId: 'js-npm-express-api' }
  });

  assert.equal(report.run.asOf, '2025-06-01T00:00:00.000Z');
  assert.deepEqual(report.experiment, {
    id: 'daily-2025-06-01',
    fixtureId: 'js-npm-express-api'
  });
});

test('writeRunReport omits experiment when no metadata is present', async () => {
  const run = makeRunContext('patch', '/tmp/example');
  const { report } = await writeRunReport({ run, status: 'up_to_date', repo: 'example' });
  assert.equal('experiment' in report, false);
  assert.equal('asOf' in report.run, false);
});

test('bridge publish writes the final report with the publish section', async () => {
  const dir = await tempDir('bridge-final-');

  await fs.writeFile(
    path.join(dir, 'bridge-report.v1.json'),
    JSON.stringify({
      schemaVersion: 'bridge-report.v1',
      run: { id: 'run-x', status: 'handoff_ready' },
      outcome: {}
    })
  );
  await writeHandoffOutcome({
    handoffDir: dir,
    runId: 'run-x',
    status: 'blocked',
    repository: { fullName: 'bridge-fleet/js-npm-canary' },
    message: 'Release-age cooldown blocked @pg/fresh@2.0.1',
    gateType: 'cooldown_block'
  });

  const ok = await publishCommand({
    handoffDir: dir,
    env: { ...process.env, BRIDGE_API_URL: '', GITHUB_ACTIONS: '' },
    fetchImpl: async () => {
      throw new Error('publish should not reach the network for a blocked bundle');
    }
  });

  assert.equal(ok, true);
  const finalReport = JSON.parse(
    await fs.readFile(path.join(dir, 'bridge-report.final.json'), 'utf8')
  );
  assert.equal(finalReport.publish.status, 'blocked');
  assert.equal(finalReport.schemaVersion, 'bridge-report.v1');

  await fs.rm(dir, { recursive: true, force: true });
});
