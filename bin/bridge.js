#!/usr/bin/env node

import { createRequire } from 'node:module';

import { Command } from 'commander';

import { configCommand } from '../src/commands/config.js';
import { initCommand } from '../src/commands/init.js';
import { patchCommand } from '../src/commands/patch.js';
import { validateCommand } from '../src/commands/validate.js';
import { error } from '../src/ui/logger.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json');

const program = new Command();

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
  .description('Copy, patch dependencies, and push a PR branch')
  .action(async () => {
    const ok = await patchCommand();
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

program.showHelpAfterError();

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parseAsync(process.argv).catch((programError) => {
    error(programError.message || 'Unknown error');
    process.exitCode = 1;
  });
}
