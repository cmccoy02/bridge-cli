// npm prepack/postpack hook. An installed Bridge has no .git of its own, so the
// commit it was built from is recorded in build-info.json for `bridge --version`
// and the PR body. `--clean` removes the file again after the tarball is built.
import fs from 'node:fs';

import { getBuildInfoPath, writeBuildInfo } from '../src/core/bridgeVersion.js';

if (process.argv.includes('--clean')) {
  fs.rmSync(getBuildInfoPath(), { force: true });
} else {
  const result = writeBuildInfo();

  if (result.written) {
    console.log(`build-info.json: ${result.gitSha}`);
  } else {
    console.warn('build-info.json not written: not packing from a Bridge git checkout.');
  }
}
