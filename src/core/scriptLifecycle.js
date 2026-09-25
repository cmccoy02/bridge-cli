/**
 * Documented scope-workflow order for `bridge patch`.
 *
 * 1. Establish a faithful baseline from the committed lockfile (install as needed).
 * 2. Run beforeScripts on that baseline before any update/candidate mutation.
 * 3. Perform the dependency update and candidate install.
 * 4. Run afterScripts on the candidate tree.
 * 5. Diff before vs after — only NEW failures block push/PR.
 */
export const SCOPE_WORKFLOW_PHASE_ORDER = [
  'audit_before',
  'baseline_lockfile',
  'baseline_clean',
  'baseline_install',
  'beforeScripts',
  'bundle_before',
  'update',
  'candidate_reinstall',
  'audit_after',
  'afterScripts',
  'scriptDiff',
  'bundle_after'
];

export function normalizeWorkflowPhase(phase) {
  const raw = String(phase || '').trim();
  if (!raw) {
    return '';
  }

  return raw.split(':')[0];
}

export function extractWorkflowPhases(phaseNames = []) {
  const known = new Set(SCOPE_WORKFLOW_PHASE_ORDER);
  const extracted = [];

  for (const phaseName of phaseNames) {
    const base = normalizeWorkflowPhase(phaseName);

    if (!known.has(base)) {
      continue;
    }

    if (extracted[extracted.length - 1] !== base) {
      extracted.push(base);
    }
  }

  return extracted;
}

export function describeScriptLifecycleOrder(phaseNames = []) {
  const phases = extractWorkflowPhases(phaseNames);
  const beforeScriptsIndex = phases.indexOf('beforeScripts');
  const updateIndex = phases.indexOf('update');
  const afterScriptsIndex = phases.indexOf('afterScripts');
  const baselineInstallIndex = phases.indexOf('baseline_install');
  const candidateIndex = phases.indexOf('candidate_reinstall');

  return {
    phases,
    beforeScriptsIndex,
    updateIndex,
    afterScriptsIndex,
    baselineInstallIndex,
    candidateIndex,
    beforeScriptsRunOnBaseline:
      beforeScriptsIndex !== -1 &&
      updateIndex !== -1 &&
      beforeScriptsIndex < updateIndex &&
      (baselineInstallIndex === -1 || baselineInstallIndex < beforeScriptsIndex),
    afterScriptsRunOnCandidate:
      afterScriptsIndex !== -1 &&
      updateIndex !== -1 &&
      afterScriptsIndex > updateIndex &&
      (candidateIndex === -1 || candidateIndex < afterScriptsIndex)
  };
}
