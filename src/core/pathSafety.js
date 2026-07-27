import fs from 'node:fs/promises';
import path from 'node:path';

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolvePathInside(rootDir, requestedPath = '.') {
  const root = path.resolve(rootDir);
  const raw = typeof requestedPath === 'string' ? requestedPath.trim() : '';

  if (!raw || raw === '.') {
    return root;
  }

  if (path.isAbsolute(raw)) {
    throw new Error(`Unsafe scope path "${requestedPath}": absolute paths are not allowed.`);
  }

  const resolved = path.resolve(root, raw);

  if (!isInside(root, resolved)) {
    throw new Error(
      `Unsafe scope path "${requestedPath}": scope must remain inside the isolated repository.`
    );
  }

  return resolved;
}

export async function resolveRealPathInside(rootDir, requestedPath = '.') {
  const lexicalPath = resolvePathInside(rootDir, requestedPath);
  const [realRoot, realCandidate] = await Promise.all([
    fs.realpath(path.resolve(rootDir)),
    fs.realpath(lexicalPath)
  ]);

  if (!isInside(realRoot, realCandidate)) {
    throw new Error(
      `Unsafe scope path "${requestedPath}": symlink resolves outside the isolated repository.`
    );
  }

  return realCandidate;
}
