import { execSync } from 'node:child_process';

try {
  execSync('git diff --quiet HEAD -- package-lock.json package.json', {
    stdio: 'ignore'
  });
  process.exit(0);
} catch {
  console.error('FAIL - simulated regression: lockfile changed after the update');
  process.exit(1);
}
