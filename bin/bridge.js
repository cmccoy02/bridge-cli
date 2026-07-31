#!/usr/bin/env node

import { createRequire } from 'node:module';

import { Command } from 'commander';

import { configCommand } from '../src/commands/config.js';
import { initCommand } from '../src/commands/init.js';
import { patchCommand } from '../src/commands/patch.js';
import { reportCommand } from '../src/commands/report.js';
import { doctorCommand, validateCommand } from '../src/commands/validate.js';
import { error } from '../src/ui/logger.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

const program = new Command();

function collectOption(value, previous = []) {
  return [...previous, value];
}

program
  .name('bridge')
  .description('Automated, non-breaking dependency updates. One command. One PR.')
  .version(packageJson.version);

program
  .command('init')
  .description('Interactive onboarding that creates bridge.config.json')
  .action(async () => {
    const ok = await initCommand();
    if (!ok) {
      process.exitCode = 1;
    }
  });

program
  .command('patch')
  .description('Safely copy, patch, validate dependencies, and push a candidate branch')
  .option('--dry-run', 'Run without committing or pushing')
  .option('--keep-workspace', 'Keep the isolated workspace after a dry run for debugging')
  .option('--verbose', 'Stream command output while each phase runs')
  .option('--scope <path>', 'Run only the root (.) or one configured nested scope')
  .option(
    '--local-package <name=path>',
    'Use a local npm package only inside the isolated run (repeatable)',
    collectOption,
    []
  )
  .action(async (options) => {
    const ok = await patchCommand({
      dryRun: options.dryRun,
      keepWorkspace: options.keepWorkspace,
      verbose: options.verbose,
      scope: options.scope,
      localPackages: options.localPackage
    });
    if (!ok) {
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description('Check local setup, project configuration, and local package links')
  .option('--offline', 'Skip repository reachability check')
  .option(
    '--local-package <name=path>',
    'Validate a local npm package substitution (repeatable)',
    collectOption,
    []
  )
  .action(async (options) => {
    const ok = await doctorCommand({
      offline: options.offline,
      localPackages: options.localPackage
    });

    if (!ok) {
      process.exitCode = 1;
    }
  });

program
  .command('validate')
  .description('Validate bridge.config.json and command availability')
  .option('--offline', 'Skip repository reachability check')
  .action(async (options) => {
    const ok = await validateCommand({ offline: options.offline });
    if (!ok) {
      process.exitCode = 1;
    }
  });

program
  .command('config')
  .description('Print current bridge.config.json')
  .action(async () => {
    try {
      await configCommand();
    } catch (configError) {
      error(configError.message);
      process.exitCode = 1;
    }
  });

program
  .command('report')
  .description('Summarize Bridge history or show the latest detailed run report')
  .option('--json', 'Print machine-readable report JSON')
  .option('--latest [run-id]', 'Show the newest saved detailed run report, or one run by ID')
  .option('--repo <name>', 'Filter metrics to a single repo name')
  .option('--limit <n>', 'Top-N packages for ranked lists', '10')
  .action(async (options) => {
    const ok = await reportCommand({
      json: options.json,
      latest: options.latest,
      repo: options.repo,
      limit: options.limit
    });

    if (!ok) {
      process.exitCode = 1;
    }
  });

program.showHelpAfterError();

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parseAsync(process.argv).catch((programError) => {
    error(programError.message || 'Unknown error');
    process.exitCode = 1;
  });
}
