/**
 * Script diff logic for before/after validation comparisons.
 *
 * Captures baseline script failures and compares them against after-script
 * results to detect NEW failures (regressions) vs baseline noise.
 */

function normalizeOutput(text, limit = 500) {
  const trimmed = (text || '').trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed.length <= limit) {
    return trimmed;
  }

  return `${trimmed.slice(0, limit)}... [truncated]`;
}

function createScriptFingerprint(result) {
  return {
    command: result.command || '',
    exitCode: result.code ?? result.exitCode ?? null,
    output: normalizeOutput(result.stderr || result.stdout || '')
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
    fingerprint: createScriptFingerprint(result)
  }));
}

export function getFailedScripts(scriptResults) {
  return scriptResults.filter((result) => !result.success);
}

function commandsMatch(a, b) {
  return a.command === b.command;
}

function failuresMatch(beforeFailure, afterFailure) {
  if (!commandsMatch(beforeFailure, afterFailure)) {
    return false;
  }

  return beforeFailure.fingerprint.exitCode === afterFailure.fingerprint.exitCode;
}

export function compareScriptResults(beforeResults, afterResults) {
  const beforeFailures = getFailedScripts(beforeResults);
  const afterFailures = getFailedScripts(afterResults);

  const newFailures = [];
  const baselineFailures = [];
  const resolved = [];

  for (const afterFailure of afterFailures) {
    const matchingBefore = beforeFailures.find((before) =>
      failuresMatch(before, afterFailure)
    );

    if (matchingBefore) {
      baselineFailures.push({
        before: matchingBefore,
        after: afterFailure
      });
    } else {
      newFailures.push(afterFailure);
    }
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
    newFailures,
    baselineFailures,
    resolved
  };
}

export function formatScriptDiffSummary(comparison) {
  if (!comparison) {
    return 'Script validation: not available';
  }

  const parts = [];

  if (comparison.newFailureCount > 0) {
    parts.push(`${comparison.newFailureCount} NEW failure(s)`);
  }

  if (comparison.baselineFailureCount > 0) {
    parts.push(`${comparison.baselineFailureCount} baseline failure(s) (unchanged)`);
  }

  if (comparison.resolvedCount > 0) {
    parts.push(`${comparison.resolvedCount} resolved`);
  }

  if (parts.length === 0) {
    return 'Script validation: all scripts passed';
  }

  return `Script validation: ${parts.join(', ')}`;
}

export function createScriptDiffReport(beforeResults, afterResults) {
  const comparison = compareScriptResults(beforeResults, afterResults);

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
        exitCode: f.exitCode
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
      hasBaselineNoise: comparison.hasBaselineNoise
    }
  };
}
