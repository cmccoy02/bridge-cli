#!/usr/bin/env node

import { Command } from 'commander';

import { configCommand } from '../src/commands/config.js';
import { initCommand } from '../src/commands/init.js';
import { patchCommand } from '../src/commands/patch.js';
import { reportCommand } from '../src/commands/report.js';
import {
  scheduleInstallCommand,
  scheduleLatestCommand,
  scheduleRunCommand,
  scheduleStatusCommand,
  scheduleUninstallCommand
} from '../src/commands/schedule.js';
import { doctorCommand, validateCommand } from '../src/commands/validate.js';
import { getBridgeVersion } from '../src/core/bridgeVersion.js';
import { error } from '../src/ui/logger.js';

const program = new Command();

function collectOption(value, previous = []) {
  return [...previous, value];
}

program
  .name('bridge')
  .description('Automated, non-breaking dependency updates. One command. One PR.')
  .version(getBridgeVersion());

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
  .option(
    '--block-on-baseline-failures',
    'Stop before push/PR when before-scripts already fail on the committed baseline'
  )
  .option(
    '--skip-before-scripts',
    'Skip configured beforeScripts; capture baseline by running afterScripts on the committed lockfile tree'
  )
  .option(
    '--run-before-scripts',
    'Force beforeScripts to run even when skipBeforeScripts is set in config'
  )
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
      blockOnBaselineFailures: options.blockOnBaselineFailures,
      skipBeforeScripts: options.skipBeforeScripts,
      runBeforeScripts: options.runBeforeScripts,
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

const schedule = program
  .command('schedule')
  .description(
    'Install or run local scheduling (CLI-managed launchd/cron, or the modular bridge-daily.sh runner)'
  );

schedule
  .command('install')
  .description('Write a launchd plist or cron snippet for unattended daily runs')
  .option('--repo <git-url-or-path>', 'Repository to schedule (repeatable)', collectOption, [])
  .option('--branch <name>', 'Default branch', 'main')
  .option('--config <path>', 'Bridge config to copy into the isolated clone')
  .option('--time <HH:MM>', 'Local time to run', '07:30')
  .option('--runner <cli|script>', 'cli = bridge schedule run; script = bridge-daily.sh', 'cli')
  .option('--print', 'Print the generated unit instead of writing it')
  .option('--cron', 'Write a cron snippet even on macOS')
  .option('--launchd', 'Write a LaunchAgent even when --print is not set')
  .action(async (options) => {
    const ok = await scheduleInstallCommand({
      repo: options.repo,
      branch: options.branch,
      config: options.config,
      time: options.time,
      runner: options.runner,
      print: options.print,
      cron: options.cron,
      launchd: options.launchd
    });
    if (!ok) {
      process.exitCode = 1;
    }
  });

schedule
  .command('uninstall')
  .description('Remove generated LaunchAgent / cron snippet files')
  .option('--unload', 'Print the launchctl bootout command')
  .action(async (options) => {
    const ok = await scheduleUninstallCommand({ unload: options.unload });
    if (!ok) {
      process.exitCode = 1;
    }
  });

schedule
  .command('status')
  .description('Show whether a generated schedule file and latest summary exist')
  .action(async () => {
    const ok = await scheduleStatusCommand();
    if (!ok) {
      process.exitCode = 1;
    }
  });

schedule
  .command('run')
  .description(
    'Run one or more repos now (scheduled defaults: skip before-scripts, per-repo lock, concurrency 2)'
  )
  .option('--repo <git-url-or-path>', 'Repository to run (repeatable)', collectOption, [])
  .option('--branch <name>', 'Default branch')
  .option('--config <path>', 'Bridge config to copy into the isolated clone')
  .option('--concurrency <n>', 'Max parallel repos', '2')
  .option('--dry-run', 'Pass --dry-run to each Bridge run')
  .option('--run-before-scripts', 'Do not skip beforeScripts (scheduled default stays skipped)')
  .option('--notify', 'Show a local notification after the daily summary is written')
  .option('--notify-command <cmd>', 'Command to run with BRIDGE_SUMMARY_PATH / BRIDGE_SUMMARY_TEXT')
  .action(async (options) => {
    const ok = await scheduleRunCommand({
      repo: options.repo,
      branch: options.branch,
      config: options.config,
      concurrency: options.concurrency,
      dryRun: options.dryRun,
      runBeforeScripts: options.runBeforeScripts,
      notify: options.notify,
      notifyCommand: options.notifyCommand
    });
    if (!ok) {
      process.exitCode = 1;
    }
  });

schedule
  .command('latest')
  .description('Print the latest daily summary (~/.bridge/schedule/LATEST.md)')
  .option('--json', 'Print path + text as JSON')
  .option('--notify', 'Re-send the latest summary through the local notification hook')
  .action(async (options) => {
    const ok = await scheduleLatestCommand({
      json: options.json,
      notify: options.notify
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
