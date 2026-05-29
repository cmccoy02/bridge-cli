export const CONFIG_FILE_NAME = 'bridge.config.json';
export const DEFAULT_BRANCH_PREFIX = 'bridge/patch';

export const REQUIRED_CONFIG_FIELDS = [
  'packageManager',
  'installCommand',
  'updateCommand',
  'cleanCommands'
];

export const PACKAGE_MANAGER_PRESETS = {
  npm: {
    label: 'Node.js project using npm',
    installCommand: 'npm install',
    updateCommand: 'npm update',
    cleanCommands: ['rm -rf node_modules', 'rm -f package-lock.json'],
    lockfile: 'package-lock.json',
    lockfileFormat: 'json-npm',
    manifest: 'package.json'
  },
  yarn: {
    label: 'Node.js project using yarn',
    installCommand: 'yarn install',
    updateCommand: 'yarn upgrade',
    cleanCommands: ['rm -rf node_modules', 'rm -f yarn.lock'],
    lockfile: 'yarn.lock',
    lockfileFormat: null,
    manifest: 'package.json'
  },
  pnpm: {
    label: 'Node.js project using pnpm',
    installCommand: 'pnpm install',
    updateCommand: 'pnpm update',
    cleanCommands: ['rm -rf node_modules', 'rm -f pnpm-lock.yaml'],
    lockfile: 'pnpm-lock.yaml',
    lockfileFormat: null,
    manifest: 'package.json'
  },
  poetry: {
    label: 'Python project using poetry',
    installCommand: 'poetry install --no-interaction',
    updateCommand: 'poetry update --lock --no-interaction',
    cleanCommands: [],
    lockfile: 'poetry.lock',
    lockfileFormat: 'toml-poetry',
    manifest: 'pyproject.toml'
  },
  pipenv: {
    label: 'Python project using pipenv',
    installCommand: 'pipenv install --dev',
    updateCommand: 'pipenv update',
    cleanCommands: [],
    lockfile: 'Pipfile.lock',
    lockfileFormat: 'json-pipfile',
    manifest: 'Pipfile'
  },
  'pip-compile': {
    label: 'Python project using pip-tools (pip-compile)',
    installCommand: 'pip-sync requirements.txt',
    updateCommand: 'pip-compile --upgrade requirements.in',
    cleanCommands: [],
    lockfile: 'requirements.txt',
    lockfileFormat: 'pip-compile',
    manifest: 'requirements.in'
  },
  uv: {
    label: 'Python project using uv',
    installCommand: 'uv sync',
    // NOTE: uv CLI flags move quickly; verify --upgrade semantics against installed uv version.
    updateCommand: 'uv lock --upgrade',
    cleanCommands: [],
    lockfile: 'uv.lock',
    lockfileFormat: 'toml-uv',
    manifest: 'pyproject.toml'
  },
  pip: {
    label: 'Python project using pip',
    installCommand:
      '.bridge-venv/bin/python -m pip install --upgrade pip && .bridge-venv/bin/python -m pip install -r requirements.txt',
    updateCommand:
      '.bridge-venv/bin/python -m pip install --upgrade -r requirements.txt && .bridge-venv/bin/python -m pip freeze --exclude-editable | grep -Ev "^(pip|setuptools|wheel)==" > requirements.txt',
    cleanCommands: ['rm -rf .bridge-venv', 'python3 -m venv .bridge-venv'],
    lockfile: null,
    lockfileFormat: null,
    manifest: null
  },
  mix: {
    label: 'Elixir project using mix',
    installCommand: 'mix deps.get',
    updateCommand: 'mix deps.update --all',
    cleanCommands: ['rm -rf deps', 'rm -rf _build', 'rm -f mix.lock'],
    lockfile: null,
    lockfileFormat: null,
    manifest: null
  }
};

export const PACKAGE_MANAGER_OPTIONS = [
  'npm',
  'yarn',
  'pnpm',
  'poetry',
  'pipenv',
  'pip-compile',
  'uv',
  'pip',
  'mix'
];

export const DEFAULT_CONFIG = {
  name: '',
  packageManager: 'npm',
  installCommand: PACKAGE_MANAGER_PRESETS.npm.installCommand,
  updateCommand: PACKAGE_MANAGER_PRESETS.npm.updateCommand,
  cleanCommands: [...PACKAGE_MANAGER_PRESETS.npm.cleanCommands],
  beforeScripts: [],
  afterScripts: [],
  branchPrefix: DEFAULT_BRANCH_PREFIX
};
