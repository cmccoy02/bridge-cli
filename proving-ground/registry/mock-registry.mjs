#!/usr/bin/env node
// In-job mock npm registry for the proving ground. Serves the planted @pg packages
// (see catalog/scenarios.json) with publish times set relative to "now", so the
// release-age cooldown cases are reproducible. No network, no Docker: it only serves
// packages built from registry/packages/. Point a scope at it, e.g. in .npmrc:
//
//   @pg:registry=http://localhost:4873/
//
// Usage:
//   node mock-registry.mjs --port 4873 --packages ./packages --ages ./ages.json
//
// It stays in the foreground; a setup script backgrounds it for a CI job.

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStore, packageNameFromPath, packumentForHost } from './lib/packument.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { port: 4873, packages: path.join(HERE, 'packages'), ages: '', now: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--port') (args.port = Number(value)), (i += 1);
    else if (flag === '--packages') (args.packages = path.resolve(value)), (i += 1);
    else if (flag === '--ages') (args.ages = path.resolve(value)), (i += 1);
    else if (flag === '--now') (args.now = value), (i += 1);
  }
  return args;
}

async function readAges(agesPath) {
  if (!agesPath) return {};
  try {
    return JSON.parse(await fs.readFile(agesPath, 'utf8'));
  } catch {
    return {};
  }
}

export async function createRegistryServer({ packagesDir, ages = {}, now = Date.now() } = {}) {
  const store = await buildStore({ packagesDir, ages, now });

  const server = http.createServer((req, res) => {
    const host = req.headers.host || 'localhost';
    const baseUrl = `http://${host}`;
    const url = new URL(req.url, baseUrl);

    if (url.pathname === '/' || url.pathname === '/-/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, packages: [...store.keys()] }));
      return;
    }

    const { name, filename } = packageNameFromPath(url.pathname);
    const entry = store.get(name);

    if (!entry) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'package not found' }));
      return;
    }

    if (filename) {
      const tarball = entry.tarballs.get(filename);
      if (!tarball) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'tarball not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tarball.tarball);
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(packumentForHost(entry, baseUrl)));
  });

  return { server, store };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ages = await readAges(args.ages);
  const now = args.now ? Date.parse(args.now) : Date.now();
  const { server, store } = await createRegistryServer({
    packagesDir: args.packages,
    ages,
    now: Number.isFinite(now) ? now : Date.now()
  });

  server.listen(args.port, () => {
    const packages = [...store.keys()].join(', ');
    process.stdout.write(
      `mock registry listening on http://localhost:${args.port} (${store.size} packages: ${packages})\n`
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`mock registry failed: ${error.message}\n`);
    process.exit(1);
  });
}
