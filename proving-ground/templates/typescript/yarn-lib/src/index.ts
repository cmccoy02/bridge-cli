import pkg from '@pg/semver-lie';

// Calls greet(), which @pg/semver-lie 1.2.1 renames in a patch. The test below
// exercises this path, so the breaking change must be caught by the checks gate.
export function hello(name: string): string {
  return pkg.greet(name);
}
