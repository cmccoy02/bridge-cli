import { execSync } from 'node:child_process';

console.error('BASELINE_ERROR: known lint failure');

try {
  execSync('git diff --quiet HEAD -- package-lock.json package.json', {
    stdio: 'ignore'
  });
} catch {
  console.error('NEW_ERROR: introduced by the update');
}

process.exit(1);
