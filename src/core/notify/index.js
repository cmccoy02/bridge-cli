import { logActivity } from '../activityLogger.js';
import { getBridgeVersion } from '../bridgeVersion.js';
import { inspectSettingsPermissions, loadBridgeSettings } from '../bridgeSettings.js';
import {
  defaultNotifyCommand,
  notifyDailySummary,
  notifyPayloadFromEvent,
  sendLocalNotification
} from '../notifyLocal.js';
import { redactSensitiveText } from '../redaction.js';
import { warn } from '../../ui/logger.js';
import {
  buildNotifyEventFromBatch,
  buildNotifyEventFromReport,
  buildSampleNotifyEvent,
  classifyNotifyOutcome,
  DEFAULT_NOTIFY_ON,
  HEARTBEAT_OUTCOMES,
  isBatchMember,
  isOutcomeEnabled,
  NOTIFY_SCHEMA,
  outcomeHeader
} from './event.js';
import { buildSlackPayload, deliverSlack, resolveSlackWebhook } from './slack.js';
import { loadNotifyState } from './state.js';
import { formatTerminalLines, printTerminalCard } from './terminal.js';

export {
  buildNotifyEventFromBatch,
  buildNotifyEventFromReport,
  buildSampleNotifyEvent,
  buildSlackPayload,
  classifyNotifyOutcome,
  DEFAULT_NOTIFY_ON,
  formatTerminalLines,
  HEARTBEAT_OUTCOMES,
  isBatchMember,
  isOutcomeEnabled,
  NOTIFY_SCHEMA,
  outcomeHeader,
  printTerminalCard,
  resolveSlackWebhook
};

function commandIsConfigured(settings, env, notifyCommand, platform) {
  return Boolean(
    (typeof notifyCommand === 'string' && notifyCommand.trim()) ||
      settings?.notifyCommand ||
      env.BRIDGE_NOTIFY_COMMAND ||
      defaultNotifyCommand(platform)
  );
}

function batchHasEnabledOutcome(event, settings) {
  const outcomes = Array.isArray(event.repos)
    ? event.repos.map((entry) => entry.outcome)
    : [event.outcome];
  return outcomes.some((outcome) => isOutcomeEnabled(outcome, settings));
}

export function formatSlackDoctorLine({ configured = false, lastFailed = false } = {}) {
  if (!configured) {
    return 'Slack: not configured';
  }
  if (lastFailed) {
    return 'Slack: last send failed';
  }
  return 'Slack: configured';
}

export async function getSlackDoctorStatus({
  bridgeHome,
  env = process.env,
  settings
} = {}) {
  const resolvedSettings = settings || (await loadBridgeSettings({ bridgeHome, env }));
  const webhook = resolveSlackWebhook({ settings: resolvedSettings, env });
  const state = await loadNotifyState(bridgeHome);
  const lastFailed = Boolean(webhook) && state.slack?.lastOk === false;
  const status = {
    configured: Boolean(webhook),
    lastFailed,
    line: formatSlackDoctorLine({
      configured: Boolean(webhook),
      lastFailed
    })
  };
  return JSON.parse(redactSensitiveText(JSON.stringify(status)));
}

async function sendCommandChannel(event, options) {
  const {
    settings,
    env,
    bridgeHome,
    notifyCommand,
    commandEnabled,
    platform = process.platform
  } = options;

  if (event.kind === 'batch') {
    return notifyDailySummary({
      summaryText: event.summaryText || '',
      summaryPath: event.reportPath || '',
      enabled: commandEnabled,
      notifyCommand,
      bridgeHome,
      env,
      platform
    });
  }

  const shouldNotify =
    commandEnabled === true ||
    (commandEnabled !== false &&
      (settings.notify || Boolean(settings.notifyCommand) || Boolean(env.BRIDGE_NOTIFY)));

  if (!shouldNotify) {
    return { sent: false, reason: 'disabled' };
  }

  const payload = notifyPayloadFromEvent(event);
  return sendLocalNotification({
    title: payload.title,
    body: payload.body,
    summaryPath: event.reportPath || '',
    summaryText: event.summaryText || '',
    notifyCommand,
    bridgeHome,
    env,
    platform
  });
}

export async function dispatchNotify(event, options = {}) {
  const {
    env = process.env,
    bridgeHome,
    fetchImpl,
    skipTerminal = false,
    skipSlack = false,
    skipCommand = false,
    notifyCommand,
    commandEnabled,
    platform = process.platform,
    settings: providedSettings,
    force = false
  } = options;

  const warnings = [];
  const channels = {
    terminal: { sent: false, reason: 'skipped' },
    slack: { sent: false, reason: 'skipped' },
    command: { sent: false, reason: 'skipped' }
  };

  try {
    const inspection = await inspectSettingsPermissions(bridgeHome);
    if (inspection.warning) {
      warnings.push(inspection.warning);
      warn(inspection.warning);
    }

    const settings = providedSettings || (await loadBridgeSettings({ bridgeHome, env }));
    const slackAllowed =
      force || event.kind === 'test'
        ? true
        : event.kind === 'batch'
          ? batchHasEnabledOutcome(event, settings)
          : isOutcomeEnabled(event.outcome, settings);

    if (!skipTerminal) {
      printTerminalCard(event);
      channels.terminal = { sent: true, reason: '' };
    }

    if (!skipSlack) {
      if (!slackAllowed) {
        channels.slack = { sent: false, reason: 'filtered' };
      } else {
        channels.slack = await deliverSlack(event, {
          settings,
          env,
          bridgeHome,
          fetchImpl
        });
      }
    }

    if (!skipCommand) {
      const commandAllowed =
        event.kind === 'batch' || force || event.kind === 'test' || slackAllowed;
      if (!commandAllowed) {
        channels.command = { sent: false, reason: 'filtered' };
      } else if (
        event.kind === 'test' &&
        !commandIsConfigured(settings, env, notifyCommand, platform)
      ) {
        channels.command = { sent: false, reason: 'not_configured' };
      } else {
        channels.command = await sendCommandChannel(event, {
          settings,
          env,
          bridgeHome,
          notifyCommand,
          commandEnabled: event.kind === 'test' ? true : commandEnabled,
          platform
        });
      }
    }

    return {
      sent:
        channels.terminal.sent === true ||
        channels.slack.sent === true ||
        channels.command.sent === true,
      slack: channels.slack,
      command: channels.command,
      terminal: channels.terminal,
      warnings,
      event
    };
  } catch (error) {
    const reason = redactSensitiveText(error?.message || 'notify failed');
    await logActivity('notify_failed', {
      runId: event?.runId || '',
      channel: 'all',
      reason
    });
    return {
      sent: false,
      slack: channels.slack,
      command: channels.command,
      terminal: channels.terminal,
      warnings,
      event,
      reason
    };
  }
}

export async function notifyFromReport({
  report,
  reportPath = '',
  run = null,
  env = process.env,
  bridgeHome,
  ...dispatchOptions
} = {}) {
  try {
    const event = buildNotifyEventFromReport(report, {
      reportPath,
      bridgeVersion: getBridgeVersion(),
      batchId: run?.batchId || report?.run?.batchId || ''
    });

    if (isBatchMember(event, env)) {
      return { sent: false, reason: 'batch_member', event, slack: { sent: false } };
    }

    return await dispatchNotify(event, { env, bridgeHome, ...dispatchOptions });
  } catch (error) {
    const reason = redactSensitiveText(error?.message || 'notify failed');
    await logActivity('notify_failed', {
      runId: report?.run?.id || run?.runId || '',
      channel: 'all',
      reason
    });
    return { sent: false, reason, event: null, slack: { sent: false } };
  }
}

export async function notifyBatch({
  daily,
  env = process.env,
  bridgeHome,
  notify = false,
  notifyCommand = '',
  ...dispatchOptions
} = {}) {
  try {
    const event = buildNotifyEventFromBatch({
      daily,
      bridgeVersion: getBridgeVersion()
    });
    return await dispatchNotify(event, {
      env,
      bridgeHome,
      skipTerminal: true,
      commandEnabled: notify || undefined,
      notifyCommand,
      ...dispatchOptions
    });
  } catch (error) {
    const reason = redactSensitiveText(error?.message || 'notify failed');
    await logActivity('notify_failed', {
      runId: daily?.model?.batch?.id || '',
      channel: 'all',
      reason
    });
    return { sent: false, reason, slack: { sent: false } };
  }
}

function formatChannelLine(name, result) {
  if (!result || result.reason === 'skipped') {
    return `${name.padEnd(10)} skip  not requested`;
  }
  if (result.reason === 'not_configured' || result.reason === 'disabled' || result.reason === 'no_command') {
    return `${name.padEnd(10)} skip  not configured`;
  }
  if (result.sent) {
    return `${name.padEnd(10)} ok`;
  }
  return `${name.padEnd(10)} fail  ${redactSensitiveText(result.reason || 'error')}`;
}

export async function notifyTest(options = {}) {
  const event = buildSampleNotifyEvent();
  const result = await dispatchNotify(event, { ...options, force: true });
  const lines = [
    formatChannelLine('terminal', result.terminal),
    formatChannelLine('slack', result.slack),
    formatChannelLine('command', result.command)
  ];
  return { ...result, lines, event };
}
