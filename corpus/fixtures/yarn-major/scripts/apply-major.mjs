import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
packageJson.dependencies.semver = '^7.0.0';
fs.writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);

fs.writeFileSync(
  'yarn.lock',
  `# yarn lockfile v1


left-pad@^1.3.0:
  version "1.3.0"
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#5b8a3a2718ca4dcfd2b274d4442c4431bc9b573c"
  integrity sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2EqN7CRsaTmIITYbHHxzYkt4w==

semver@^7.0.0:
  version "7.6.3"
  resolved "https://registry.yarnpkg.com/semver/-/semver-7.6.3.tgz#b205c29b53cba6b3a57906c7e1132222d428e8bb"
  integrity sha512-uwETB8kDPj6d2YIQAxlOGpqXXg/hrA7PYeVau+vI3M/sxdd1lv7Z9PYhSGNiE6nHnDrtU/Tglq5xJQbfIJ3+dw==
`
);
