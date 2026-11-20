import { printSummary } from '../../ui/summary.js';
import { formatSecurityDelta, outcomeHeader } from './event.js';

function packageLine(packages = {}) {
  return `${packages.direct || 0} direct / ${packages.transitive || 0} trans (${packages.patch || 0} patch, ${packages.minor || 0} minor, ${packages.major || 0} major)`;
}

export function formatTerminalLines(event = {}) {
  if (event.kind === 'batch' && Array.isArray(event.repos)) {
    const lines = [
      `Outcome: ${outcomeHeader(event)}`,
      ...event.repos.map((entry) => {
        const pr = entry.prUrl ? `  ${entry.prUrl}` : '';
        return `${entry.repo}  ${outcomeHeader({ ...entry, kind: 'run' })}${pr}`;
      })
    ];
    if (event.reportPath) {
      lines.push(`Report: ${event.reportPath}`);
    }
    return lines.filter(Boolean);
  }

  const security = formatSecurityDelta(event.security);
  return [
    `Outcome: ${outcomeHeader(event)}`,
    event.prUrl ? `PR: ${event.prUrl}` : '',
    `Packages: ${packageLine(event.packages)}`,
    security ? `Security: ${security}` : '',
    event.blockedReason ? `Reason: ${event.blockedReason}` : '',
    event.reportPath ? `Report: ${event.reportPath}` : ''
  ].filter(Boolean);
}

export function printTerminalCard(event) {
  printSummary(formatTerminalLines(event), 'Bridge result');
  return { sent: true };
}
