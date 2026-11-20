#!/usr/bin/env node
// Fixture generator. Turns a catalog entry + its template into a complete fleet repo
// tree: the committed bridge.config.json, a .bridge-fixture.json copy of the catalog
// entry, a ci.yml that runs install + checks, and a .github/workflows/bridge.yml that
// the orchestrator dispatches (workflow_dispatch only, no cron). Fixtures that use the
// mock registry also get a self-contained .pg/ copy and a setup-registry.sh.
//
// Pure file generation - no network, no locking. Provisioning locks the dependencies
// to the drift date and tags `baseline`.
//
// Usage: node generate.mjs [--fixture <id>] [--out <dir>]

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  PROVING_GROUND_DIR,
  fixtureUsesHoneytokens,
  loadFixtures,
  loadFleetConfig,
  managerProfile
} from './lib/fleet.mjs';

const TEMPLATES_DIR = path.join(PROVING_GROUND_DIR, 'templates');
const REGISTRY_DIR = path.join(PROVING_GROUND_DIR, 'registry');

async function writeFile(dest, content) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function nodeSetupSteps(version, { corepack } = {}) {
  const lines = [
    '      - uses: actions/setup-node@v6',
    '        with:',
    `          node-version: '${version || '22'}'`
  ];
  if (corepack) {
    lines.push('      - name: Enable Corepack', '        run: corepack enable');
  }
  return lines;
}

function pythonSetupSteps(fixture, profile) {
  const version = fixture.languageVersions?.python || '3.12';
  const installs = {
    uv: 'python -m pip install uv',
    poetry: 'python -m pip install poetry',
    pipenv: 'python -m pip install pipenv',
    'pip-compile': 'python -m pip install pip-tools'
  };
  const lines = [
    '      - uses: actions/setup-python@v5',
    '        with:',
    `          python-version: '${version}'`,
    '      - name: Install Python package manager',
    '        run: |',
    '          python -m pip install --upgrade pip'
  ];
  if (installs[fixture.manager]) {
    lines.push(`          ${installs[fixture.manager]}`);
  }
  return lines;
}

function elixirSetupSteps(fixture) {
  return [
    '      - uses: erlef/setup-beam@v1',
    '        with:',
    `          otp-version: '${fixture.languageVersions?.otp || '27'}'`,
    `          elixir-version: '${fixture.languageVersions?.elixir || '1.17'}'`
  ];
}

function setupStepsFor(fixture, profile) {
  if (profile.kind === 'node') {
    return nodeSetupSteps(fixture.languageVersions?.node, { corepack: profile.corepack });
  }
  if (profile.kind === 'python') {
    return pythonSetupSteps(fixture, profile);
  }
  return elixirSetupSteps(fixture);
}

function renderCiYaml(fixture, config, profile) {
  const steps = ['      - uses: actions/checkout@v6', ...setupStepsFor(fixture, profile)];

  if (fixture.usesMockRegistry) {
    steps.push('      - name: Start mock registry', '        run: bash .pg/setup-registry.sh');
  }

  steps.push('      - name: Install', `        run: ${config.installCommand}`);

  for (const [index, script] of (config.afterScripts || []).entries()) {
    steps.push(`      - name: Check ${index + 1}`, `        run: ${script}`);
  }

  return [
    'name: CI',
    'on:',
    '  push:',
    '  pull_request:',
    '  workflow_dispatch:',
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...steps,
    ''
  ].join('\n');
}

function renderBridgeYaml(fixture, profile, workflowRef) {
  const withLines = [];

  if (profile.kind === 'node') {
    withLines.push(`      node-version: '${fixture.languageVersions?.node || '22'}'`);
    if (profile.npmEleven) {
      withLines.push("      npm-version: '11'");
    }
  } else if (profile.kind === 'python') {
    withLines.push(`      python-version: '${fixture.languageVersions?.python || '3.12'}'`);
  } else if (profile.kind === 'elixir') {
    withLines.push(`      otp-version: '${fixture.languageVersions?.otp || '27'}'`);
    withLines.push(`      elixir-version: '${fixture.languageVersions?.elixir || '1.17'}'`);
  }

  withLines.push(`      fixture-id: ${fixture.id}`);
  withLines.push('      experiment-id: ${{ inputs.experiment_id }}');
  withLines.push('      bridge-ref: ${{ inputs.bridge_ref }}');
  withLines.push('      as-of: ${{ inputs.as_of }}');

  if (fixture.usesMockRegistry) {
    withLines.push('      setup-script: .pg/setup-registry.sh');
  }

  return [
    'name: Bridge',
    '# Generated for the proving ground. Dispatched by the orchestrator (no cron) so',
    '# every run is countable. Edit the template, not this file.',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      experiment_id:',
    '        description: Experiment id recorded in the report.',
    '        type: string',
    "        default: ''",
    '      bridge_ref:',
    '        description: cmccoy02/bridge-cli ref to run the CLI from.',
    '        type: string',
    "        default: ''",
    '      as_of:',
    '        description: Time machine - run as if today were this ISO date.',
    '        type: string',
    "        default: ''",
    'permissions: {}',
    'jobs:',
    '  bridge:',
    `    uses: cmccoy02/bridge-cli/.github/workflows/bridge.yml@${workflowRef}`,
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    '    with:',
    ...withLines,
    '    secrets:',
    '      bridge-github-token: ${{ secrets.FLEET_BOT_TOKEN }}',
    ''
  ].join('\n');
}

function renderSetupRegistry(fixture) {
  const lines = [
    '#!/usr/bin/env bash',
    '# Starts the in-job mock npm registry (planted @pg packages) and waits for it.',
    '# Generated for the proving ground.',
    'set -euo pipefail',
    'root="$(pwd)"',
    'port="${PG_REGISTRY_PORT:-4873}"',
    'log="${RUNNER_TEMP:-/tmp}/pg-registry.log"',
    'node "$root/.pg/mock-registry.mjs" --port "$port" --packages "$root/.pg/packages" --ages "$root/.pg/ages.json" >"$log" 2>&1 &',
    'echo "started mock registry (pid $!) on port $port; log $log"',
    'for _ in $(seq 1 60); do',
    '  if curl -fsS "http://localhost:$port/-/ping" >/dev/null 2>&1; then',
    '    echo "mock registry is ready"',
    '    break',
    '  fi',
    '  sleep 0.5',
    'done'
  ];

  if (fixtureUsesHoneytokens(fixture)) {
    lines.push(
      '',
      '# Canary scenario: plant fake honeytokens for subsequent steps. Bridge must',
      '# scrub these from package scripts; any that reach the canary is a critical leak.',
      'if [ -n "${GITHUB_ENV:-}" ]; then',
      '  tok="pg-honeytoken-${GITHUB_RUN_ID:-local}"',
      '  {',
      '    echo "GH_TOKEN=$tok"',
      '    echo "GITHUB_TOKEN=$tok"',
      '    echo "BRIDGE_API_TOKEN=$tok"',
      '  } >> "$GITHUB_ENV"',
      '  mkdir -p "${RUNNER_TEMP:-/tmp}/pg-canary"',
      '  echo "planted honeytokens for the canary scenario"',
      'fi'
    );
  }

  return `${lines.join('\n')}\n`;
}

function renderReadme(fixture) {
  return [
    `# ${fixture.id}`,
    '',
    'Generated proving-ground fixture. Do not edit by hand: change the template at',
    `\`proving-ground/templates/${fixture.template}\` and regenerate.`,
    '',
    `- Ecosystem: ${fixture.ecosystem} (${fixture.manager})`,
    `- Size: ${fixture.size}, drift date: ${fixture.driftDate}, mode: ${fixture.mode}`,
    `- Scenarios: ${(fixture.scenarios || []).join(', ')}`,
    fixture.notes ? `\n${fixture.notes}` : ''
  ].join('\n');
}

function renderGitignore(profile) {
  const common = ['node_modules/', '.venv/', '.bridge-venv/', '_build/', 'deps/', '*.log'];
  return `${common.join('\n')}\n`;
}

export async function generateFixture(fixture, { outDir, workflowRef = 'main' } = {}) {
  const profile = managerProfile(fixture.manager);
  const templateDir = path.join(TEMPLATES_DIR, ...fixture.template.split('/'));
  const destDir = path.join(outDir, fixture.id);

  await fs.rm(destDir, { recursive: true, force: true });
  await fs.cp(templateDir, destDir, { recursive: true });

  // Committed config: the template is the source of truth; stamp the fixture name.
  const configPath = path.join(destDir, 'bridge.config.json');
  const config = await readJson(configPath);
  config.name = fixture.id;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  // A copy of the catalog entry travels with the repo.
  await writeFile(path.join(destDir, '.bridge-fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`);

  await writeFile(path.join(destDir, '.github', 'workflows', 'ci.yml'), renderCiYaml(fixture, config, profile));
  await writeFile(
    path.join(destDir, '.github', 'workflows', 'bridge.yml'),
    renderBridgeYaml(fixture, profile, workflowRef)
  );
  await writeFile(path.join(destDir, 'README.md'), renderReadme(fixture));
  await writeFile(path.join(destDir, '.gitignore'), renderGitignore(profile));

  if (fixture.usesMockRegistry) {
    const pgDir = path.join(destDir, '.pg');
    await fs.cp(path.join(REGISTRY_DIR, 'mock-registry.mjs'), path.join(pgDir, 'mock-registry.mjs'));
    await fs.cp(path.join(REGISTRY_DIR, 'lib'), path.join(pgDir, 'lib'), { recursive: true });
    await fs.cp(path.join(REGISTRY_DIR, 'packages'), path.join(pgDir, 'packages'), { recursive: true });
    await fs.cp(path.join(REGISTRY_DIR, 'ages.json'), path.join(pgDir, 'ages.json'));
    await writeFile(path.join(pgDir, 'setup-registry.sh'), renderSetupRegistry(fixture));
    await fs.chmod(path.join(pgDir, 'setup-registry.sh'), 0o755);
  }

  return destDir;
}

export async function generateAll({ outDir, workflowRef = 'main', only = '' } = {}) {
  const fixtures = await loadFixtures();
  const selected = only ? fixtures.filter((fixture) => fixture.id === only) : fixtures;

  if (only && selected.length === 0) {
    throw new Error(`No fixture with id "${only}"`);
  }

  const generated = [];
  for (const fixture of selected) {
    generated.push(await generateFixture(fixture, { outDir, workflowRef }));
  }

  return generated;
}

async function main() {
  const argv = process.argv.slice(2);
  let only = '';
  let outDir = path.join(PROVING_GROUND_DIR, '.generated');

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--fixture') (only = argv[i + 1]), (i += 1);
    else if (argv[i] === '--out') (outDir = path.resolve(argv[i + 1])), (i += 1);
  }

  const config = await loadFleetConfig();
  const generated = await generateAll({
    outDir,
    workflowRef: config.bridgeWorkflowRef || 'main',
    only
  });

  for (const dir of generated) {
    process.stdout.write(`generated ${path.relative(process.cwd(), dir)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`generate failed: ${error.message}\n`);
    process.exit(1);
  });
}
