/**
 * Script diff logic for before/after validation comparisons.
 *
 * Captures baseline script failures and compares them against after-script
 * results to detect NEW failures (regressions) vs baseline noise.
 *
 * Matching is command + exit code + normalized failure output. A command that
 * already fails on the baseline still blocks when the update introduces new
 * error lines (or when output changes and we cannot prove it is the same).
 */

import {
  combineCommandStreams,
  extractFailingExcerpt,
  failureOutputChanged,
  outputFromResult
} from './commandOutput.js';

function createScriptFingerprint(result) {
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const output = combineCommandStreams(stdout, stderr);

  return {
    command: result.command || '',
    exitCode: result.code ?? result.exitCode ?? null,
    output
  };
}

export function captureScriptResults(results) {
  if (!Array.isArray(results)) {
    return [];
  }

  return results.map((result) => ({
    command: result.command || '',
    success: result.success !== false,
    exitCode: result.code ?? result.exitCode ?? null,
    durationMs: result.durationMs || 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    fingerprint: createScriptFingerprint(result)
  }));
}

export function getFailedScripts(scriptResults) {
  return scriptResults.filter((result) => !result.success);
}

function commandsMatch(a, b) {
  return a.command === b.command;
}

function resultOutput(result) {
  return outputFromResult(result) || result?.fingerprint?.output || '';
}

function failuresMatch(beforeFailure, afterFailure) {
  if (!commandsMatch(beforeFailure, afterFailure)) {
    return false;
  }

  const change = failureOutputChanged(
    resultOutput(beforeFailure),
    resultOutput(afterFailure)
  );

  return !change.changed;
}

function commandWasMeasuredOnBaseline(command, beforeResults, beforeCommands) {
  if (beforeResults.some((result) => result.command === command)) {
    return true;
  }

  if (beforeCommands instanceof Set) {
    return beforeCommands.has(command);
  }

  if (Array.isArray(beforeCommands)) {
    return beforeCommands.includes(command);
  }

  return false;
}

export function compareScriptResults(beforeResults, afterResults, options = {}) {
  const beforeFailures = getFailedScripts(beforeResults);
  const afterFailures = getFailedScripts(afterResults);
  const beforeCommands = options.beforeCommands;

  const newFailures = [];
  const baselineFailures = [];
  const resolved = [];
  const outputChangedFailures = [];

  for (const afterFailure of afterFailures) {
    const matchingBefore = beforeFailures.find((before) =>
      commandsMatch(before, afterFailure)
    );
    const measuredOnBaseline = commandWasMeasuredOnBaseline(
      afterFailure.command,
      beforeResults,
      beforeCommands
    );

    if (matchingBefore && failuresMatch(matchingBefore, afterFailure)) {
      baselineFailures.push({
        before: matchingBefore,
        after: afterFailure
      });
      continue;
    }

    const annotated = { ...afterFailure };

    if (!measuredOnBaseline) {
      annotated.notMeasuredOnBaseline = true;
    } else if (matchingBefore) {
      const change = failureOutputChanged(
        resultOutput(matchingBefore),
        resultOutput(afterFailure)
      );
      annotated.outputChanged = true;
      annotated.addedErrorLines = change.added;
      annotated.conservativeMatch = change.conservative;
      outputChangedFailures.push(annotated);
    }

    newFailures.push(annotated);
  }

  for (const beforeFailure of beforeFailures) {
    const stillFailing = afterFailures.some((after) =>
      commandsMatch(beforeFailure, after)
    );

    if (!stillFailing) {
      resolved.push(beforeFailure);
    }
  }

  return {
    beforeFailureCount: beforeFailures.length,
    afterFailureCount: afterFailures.length,
    newFailureCount: newFailures.length,
    baselineFailureCount: baselineFailures.length,
    resolvedCount: resolved.length,
    hasNewFailures: newFailures.length > 0,
    hasBaselineNoise: baselineFailures.length > 0,
    hasOutputChangedFailures: outputChangedFailures.length > 0,
    newFailures,
    baselineFailures,
    outputChangedFailures,
    resolved
  };
}

export function formatNewFailureBlockMessage(label, failure) {
  const command = failure?.command || '(unknown command)';
  const exitCode = failure?.exitCode ?? failure?.code ?? '?';

  if (failure?.notMeasuredOnBaseline) {
    return (
      `${label}: after-script failure in ${command} (exit code ${exitCode}). ` +
      `This command is in afterScripts but was not in beforeScripts, so it was not measured on the committed baseline. ` +
      `Stopping before push/PR.`
    );
  }

  if (failure?.outputChanged) {
    return (
      `${label}: NEW after-script failure inside an already-failing command: ${command} ` +
      `(exit code ${exitCode}). Failure output changed after the update ` +
      `(new error lines not present on the committed baseline). Stopping before push/PR.`
    );
  }

  return (
    `${label}: NEW after-script failure introduced by the update: ${command} ` +
    `(exit code ${exitCode}). This was not present on the committed baseline. ` +
    `Stopping before push/PR.`
  );
}

export function formatBaselinePersistNotice(label, count) {
  return (
    `${label}: ${count} pre-existing baseline script failure(s) were already present ` +
    `before the update. These are not new regressions and do not block push/PR.`
  );
}

export function formatBaselineBlockNotice(label, count) {
  return (
    `${label}: ${count} baseline script failure(s) are blocking because ` +
    `blockOnBaselineFailures is enabled. Stopping before push/PR.`
  );
}

export function formatBeforeScriptsBaselineNotice(count) {
  return (
    `Before-scripts recorded ${count} failure(s) on the committed baseline. ` +
    `Pre-existing failures are not blocking; only NEW failures after the update stop push/PR.`
  );
}

export function formatResolvedFailuresNotice(label, count) {
  return `${label}: ${count} pre-existing baseline script failure(s) now pass after the update.`;
}

export function formatValidationGateReason(comparison) {
  if (comparison?.hasNewFailures) {
    const outputChanged = (comparison.newFailures || []).filter(
      (failure) => failure.outputChanged
    ).length;

    if (outputChanged > 0) {
      return (
        `${comparison.newFailureCount} NEW script failure(s) introduced by the update, ` +
        `including ${outputChanged} already-failing command(s) with new error output (blocking push/PR)`
      );
    }

    const afterOnly = (comparison.newFailures || []).filter(
      (failure) => failure.notMeasuredOnBaseline
    ).length;

    if (afterOnly > 0 && afterOnly === comparison.newFailureCount) {
      return `${comparison.newFailureCount} after-script failure(s) not measured on the baseline (blocking push/PR)`;
    }

    return `${comparison.newFailureCount} NEW script failure(s) introduced by the update (blocking push/PR)`;
  }

  if (comparison?.hasBaselineNoise) {
    return 'Pre-existing baseline failures only (already present before the update; not blocking)';
  }

  return 'All scripts passed';
}

export function formatValidationPrLine(comparison, scopeLabel) {
  if (comparison?.hasNewFailures) {
    return `- **${scopeLabel}:** ❌ ${comparison.newFailureCount} NEW failure(s) introduced by the update (blocking)`;
  }

  if (comparison?.hasBaselineNoise) {
    return `- **${scopeLabel}:** ⚠️ ${comparison.baselineFailureCount} pre-existing baseline failure(s) (already present before the update; not blocking)`;
  }

  return `- **${scopeLabel}:** ✅ all scripts passed`;
}

export function evaluateScriptValidationGate(
  comparison,
  { label = 'root', blockOnBaselineFailures = false } = {}
) {
  const blockingMessages = [];
  const notices = [];

  if (comparison?.hasNewFailures) {
    for (const failure of comparison.newFailures || []) {
      blockingMessages.push(formatNewFailureBlockMessage(label, failure));
    }
  }

  if (comparison?.hasBaselineNoise) {
    if (blockOnBaselineFailures) {
      blockingMessages.push(
        formatBaselineBlockNotice(label, comparison.baselineFailureCount)
      );
    } else {
      notices.push(formatBaselinePersistNotice(label, comparison.baselineFailureCount));
    }
  }

  if ((comparison?.resolvedCount || 0) > 0) {
    notices.push(formatResolvedFailuresNotice(label, comparison.resolvedCount));
  }

  return {
    shouldBlock: blockingMessages.length > 0,
    allowPush: blockingMessages.length === 0,
    blockingMessages,
    notices
  };
}

export function formatScriptDiffSummary(comparison) {
  if (!comparison) {
    return 'Script validation: not available';
  }

  const parts = [];

  if (comparison.newFailureCount > 0) {
    const outputChanged = (comparison.newFailures || []).filter(
      (failure) => failure.outputChanged
    ).length;
    const afterOnly = (comparison.newFailures || []).filter(
      (failure) => failure.notMeasuredOnBaseline
    ).length;

    if (outputChanged > 0) {
      parts.push(
        `${comparison.newFailureCount} NEW failure(s) introduced by the update, including output changes in already-failing commands (blocking)`
      );
    } else if (afterOnly === comparison.newFailureCount) {
      parts.push(
        `${comparison.newFailureCount} after-script failure(s) not measured on the baseline (blocking)`
      );
    } else {
      parts.push(
        `${comparison.newFailureCount} NEW failure(s) introduced by the update (blocking)`
      );
    }
  }

  if (comparison.baselineFailureCount > 0) {
    parts.push(
      `${comparison.baselineFailureCount} pre-existing baseline failure(s) (already present before the update; not blocking)`
    );
  }

  if (comparison.resolvedCount > 0) {
    parts.push(`${comparison.resolvedCount} pre-existing failure(s) resolved`);
  }

  if (parts.length === 0) {
    return 'Script validation: all scripts passed';
  }

  return `Script validation: ${parts.join(', ')}`;
}

export function createScriptDiffReport(beforeResults, afterResults, options = {}) {
  const comparison = compareScriptResults(beforeResults, afterResults, options);

  return {
    before: {
      total: beforeResults.length,
      passed: beforeResults.filter((r) => r.success).length,
      failed: comparison.beforeFailureCount,
      scripts: beforeResults.map((r) => ({
        command: r.command,
        success: r.success,
        exitCode: r.exitCode,
        durationMs: r.durationMs
      }))
    },
    after: {
      total: afterResults.length,
      passed: afterResults.filter((r) => r.success).length,
      failed: comparison.afterFailureCount,
      scripts: afterResults.map((r) => ({
        command: r.command,
        success: r.success,
        exitCode: r.exitCode,
        durationMs: r.durationMs
      }))
    },
    diff: {
      newFailures: comparison.newFailures.map((f) => ({
        command: f.command,
        exitCode: f.exitCode,
        outputChanged: Boolean(f.outputChanged),
        notMeasuredOnBaseline: Boolean(f.notMeasuredOnBaseline)
      })),
      baselineFailures: comparison.baselineFailures.map((b) => ({
        command: b.after.command,
        exitCode: b.after.exitCode
      })),
      resolved: comparison.resolved.map((r) => ({
        command: r.command,
        exitCode: r.exitCode
      })),
      hasNewFailures: comparison.hasNewFailures,
      hasBaselineNoise: comparison.hasBaselineNoise,
      hasOutputChangedFailures: comparison.hasOutputChangedFailures
    }
  };
}

export function excerptForFailure(failure) {
  return extractFailingExcerpt(failure?.stdout, failure?.stderr);
}
