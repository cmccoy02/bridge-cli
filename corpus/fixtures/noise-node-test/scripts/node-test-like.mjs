const durationMs = 3 + Math.random();
const wall = 10 + (Date.now() % 20);

console.log('TAP version 13');
console.log('1..1');
console.log('not ok 1 adds numbers');
console.log('  ---');
console.log(`  duration_ms: ${durationMs}`);
console.log("  type: 'test'");
console.log('  ...');
console.log('# tests 1');
console.log('# pass 0');
console.log('# fail 1');
console.log(`# duration ${wall}ms`);
process.exit(1);
