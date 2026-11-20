// Builds an npm registry store (packuments + tarballs) from planted package sources,
// with publish times backdated relative to "now". No Verdaccio, no Docker: an npm
// registry for install is just packument + tarball HTTP responses, and building the
// store in-process is what lets us control each version's publish time exactly (the
// release-age cooldown is the whole reason the planted cases exist).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;
const FIXED_MTIME = 1_000_000_000; // deterministic tarball bytes

function octal(value, length) {
  // `length` includes the trailing NUL; octal digits are right-aligned, zero-padded.
  return Buffer.from(value.toString(8).padStart(length - 1, '0') + '\0', 'ascii');
}

function tarHeader(name, size) {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 'utf8'); // name[100]
  octal(0o644, 8).copy(header, 100); // mode
  octal(0, 8).copy(header, 108); // uid
  octal(0, 8).copy(header, 116); // gid
  octal(size, 12).copy(header, 124); // size
  octal(FIXED_MTIME, 12).copy(header, 136); // mtime
  header.write('        ', 148, 'ascii'); // checksum placeholder = 8 spaces
  header.write('0', 156, 'ascii'); // typeflag: regular file
  header.write('ustar\0', 257, 'ascii'); // magic
  header.write('00', 263, 'ascii'); // version

  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  // checksum: 6 octal digits, NUL, space
  header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  header.write('\0 ', 154, 'ascii');
  return header;
}

function padTo512(buffer) {
  const remainder = buffer.length % BLOCK;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(BLOCK - remainder, 0)]);
}

/** Creates a gzipped npm tarball (`package/`-prefixed) from in-memory files. */
export function createTarball(files) {
  const chunks = [];

  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    chunks.push(tarHeader(file.name, data.length));
    chunks.push(padTo512(data));
  }

  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // two zero blocks terminate the archive
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

export function integrityFor(tarball) {
  return `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
}

export function shasumFor(tarball) {
  return crypto.createHash('sha1').update(tarball).digest('hex');
}

async function readDirNames(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function readFilesForPack(versionDir) {
  const files = [];
  const walk = async (current, prefix) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        files.push({ name: `package/${rel}`, data: await fs.readFile(abs) });
      }
    }
  };
  await walk(versionDir, '');
  return files;
}

function compareSemver(a, b) {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Builds the registry store from `packagesDir`.
 *
 * Layout: packagesDir/<pkg>/<version>/ (each with package.json + sources).
 * `ages` maps "<name>@<version>" to hours-before-now for the publish time; anything
 * not listed defaults to `defaultAgeHours` (old enough to clear any cooldown).
 */
export async function buildStore({
  packagesDir,
  ages = {},
  now = Date.now(),
  defaultAgeHours = 2160
} = {}) {
  const packages = new Map();
  const pkgDirs = await readDirNames(packagesDir);

  for (const pkgDir of pkgDirs.sort()) {
    const versionsRoot = path.join(packagesDir, pkgDir);
    const versionDirs = await readDirNames(versionsRoot);
    const versions = {};
    const tarballs = new Map();
    const time = {};
    let packageName = '';
    let newest = -Infinity;
    let oldest = Infinity;
    let latest = '';

    for (const version of versionDirs.sort(compareSemver)) {
      const versionDir = path.join(versionsRoot, version);
      const manifest = JSON.parse(await fs.readFile(path.join(versionDir, 'package.json'), 'utf8'));
      packageName = manifest.name;
      const files = await readFilesForPack(versionDir);
      const tarball = createTarball(files);
      const filename = `${pkgDir}-${version}.tgz`;
      const ageHours = Number.isFinite(ages[`${manifest.name}@${version}`])
        ? ages[`${manifest.name}@${version}`]
        : defaultAgeHours;
      const publishedMs = now - ageHours * 60 * 60 * 1000;
      const publishedAt = new Date(publishedMs).toISOString();

      versions[version] = {
        ...manifest,
        _id: `${manifest.name}@${version}`,
        dist: {
          // Rewritten to the serving host at request time.
          tarball: `/${manifest.name}/-/${filename}`,
          shasum: shasumFor(tarball),
          integrity: integrityFor(tarball)
        }
      };
      tarballs.set(filename, { tarball, publishedAt });
      time[version] = publishedAt;

      if (publishedMs > newest) {
        newest = publishedMs;
        latest = version;
      }
      if (publishedMs < oldest) oldest = publishedMs;
    }

    time.created = new Date(oldest).toISOString();
    time.modified = new Date(newest).toISOString();

    const packument = {
      _id: packageName,
      name: packageName,
      'dist-tags': { latest },
      versions,
      time
    };

    packages.set(packageName, { packument, tarballs });
  }

  return packages;
}

/** Normalizes an npm request path to a package name, e.g. `/@pg%2ffresh` -> `@pg/fresh`. */
export function packageNameFromPath(requestPath) {
  const decoded = decodeURIComponent(String(requestPath || '').replace(/^\/+/, ''));
  const tarballMatch = decoded.match(/^(@?[^/]+(?:\/[^/]+)?)\/-\//);
  if (tarballMatch) {
    return { name: tarballMatch[1], filename: decoded.split('/-/')[1] || '' };
  }
  return { name: decoded, filename: '' };
}

/** Returns a packument with dist.tarball rewritten to absolute URLs for `baseUrl`. */
export function packumentForHost(entry, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const versions = {};
  for (const [version, manifest] of Object.entries(entry.packument.versions)) {
    versions[version] = {
      ...manifest,
      dist: { ...manifest.dist, tarball: `${base}${manifest.dist.tarball}` }
    };
  }
  return { ...entry.packument, versions };
}
