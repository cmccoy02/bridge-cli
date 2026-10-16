const now = new Date();
const hh = String(now.getHours()).padStart(2, '0');
const mm = String(now.getMinutes()).padStart(2, '0');
const ss = String(now.getSeconds()).padStart(2, '0');
const duration = 700 + (Date.now() % 90);

console.log(' RUN  v3.2.0 /tmp/corpus-noise-vitest');
console.log(' ❯ src/always-fail.test.ts (1)');
console.log(`   × adds numbers ${Date.now() % 9}ms`);
console.log('     → expected 2 to be 3');
console.log(`   Start at  ${hh}:${mm}:${ss}`);
console.log(`   Duration  ${duration}ms (transform 12ms, setup 0ms, collect 45ms, tests 2ms)`);
process.exit(1);
