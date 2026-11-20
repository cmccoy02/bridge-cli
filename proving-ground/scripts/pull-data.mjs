#!/usr/bin/env node
// Downloads the proving-ground data (records, reports, scoreboard) and the recent raw
// release assets to a local folder for analysis agents. Runs locally with the
// operator's gh login. See proving-ground/AGENTS.md.
//
// Usage: node pull-data.mjs --since 7d --out ~/bridge-pg-data

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadFleetConfig } from './lib/fleet.mjs';
import { exec, gh, ghJson, log } from './lib/exec.mjs';

function parseSinceDays(value) {
  const match = String(value || '7d').match(/^(\d+)\s*([dw])?$/);
  if (!match) return 7;
  const n = Number(match[1]);
  return match[2] === 'w' ? n * 7 : n;
}

async function main() {
  const argv = process.argv.slice(2);
  let since = '7d';
  let out = path.join(os.homedir(), 'bridge-pg-data');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--since') (since = argv[i + 1]), (i += 1);
    else if (argv[i] === '--out') (out = argv[i + 1].replace(/^~(?=$|\/)/, os.homedir())), (i += 1);
  }

  const config = await loadFleetConfig();
  const org = config.fleetOrg;
  const days = parseSinceDays(since);
  out = path.resolve(out);

  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  await gh(['repo', 'clone', `${org}/${config.dataRepo}`, out, '--', '--depth', '1']);
  log(`records + reports in ${out}`);

  // Pull recent weekly raw release assets.
  const rawDir = path.join(out, 'raw');
  await fs.mkdir(rawDir, { recursive: true });
  const releases = await ghJson(
    ['release', 'list', '--repo', `${org}/${config.dataRepo}`, '--json', 'tagName,createdAt', '--limit', '20'],
    { allowFailure: true }
  ).catch(() => []);

  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  for (const release of releases || []) {
    if (Date.parse(release.createdAt) < cutoff) continue;
    await gh(['release', 'download', release.tagName, '--repo', `${org}/${config.dataRepo}`, '--dir', rawDir, '--pattern', '*.tar.zst'], { allowFailure: true });
    for (const asset of await fs.readdir(rawDir).catch(() => [])) {
      if (!asset.endsWith('.tar.zst')) continue;
      const archive = path.join(rawDir, asset);
      const extracted = await exec('tar', ['--use-compress-program=unzstd', '-xf', archive, '-C', rawDir], { allowFailure: true });
      if (extracted.success) {
        await fs.rm(archive, { force: true });
      } else {
        log(`  could not extract ${asset} (need zstd); left the archive in place`);
      }
    }
  }

  log(`done. raw bundles under ${rawDir}`);
}

main().catch((error) => {
  process.stderr.write(`pull-data failed: ${error.message}\n`);
  process.exit(1);
});
