# Expected Bridge Behavior: preexisting-fail

This fixture has an intentionally failing `npm run test` script.

## Scenario
- **Before update**: `npm run test` exits with code 1
- **After update**: `npm run test` exits with code 1

## Expected Bridge Behavior
Bridge uses **scriptDiff** to compare before/after script results:
- The test failure is detected in both `beforeScripts` and `afterScripts`
- Since the failure existed **before** the update, it's classified as **baseline noise**
- This is **NOT** a new regression caused by the dependency update
- Bridge should **continue** and complete the patch (dry-run or push)

## Key Concepts
- `scriptDiff.comparison.hasBaselineNoise = true` — failure existed before
- `scriptDiff.comparison.hasNewFailures = false` — no NEW failures introduced
- Bridge warns about baseline noise but does not block

## See Also
- `src/core/scriptDiff.js` for implementation details
- `compareScriptResults()` for the comparison logic
