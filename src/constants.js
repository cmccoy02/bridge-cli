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
    cleanCommands: ['rm -rf node_modules', 'rm -f package-lock.json']
  },
  yarn: {
    label: 'Node.js project using yarn',
    installCommand: 'yarn install',
    updateCommand: 'yarn upgrade',
    cleanCommands: ['rm -rf node_modules', 'rm -f yarn.lock']
  },
  pnpm: {
    label: 'Node.js project using pnpm',
    installCommand: 'pnpm install',
    updateCommand: 'pnpm update',
    cleanCommands: ['rm -rf node_modules', 'rm -f pnpm-lock.yaml']
  },
  pip: {
    label: 'Python project using pip',
    installCommand:
      '.bridge-venv/bin/python -m pip install --upgrade pip && .bridge-venv/bin/python -m pip install -r requirements.txt',
    updateCommand:
      '.bridge-venv/bin/python -m pip install --upgrade -r requirements.txt && .bridge-venv/bin/python -m pip freeze --exclude-editable | grep -Ev "^(pip|setuptools|wheel)==" > requirements.txt',
    cleanCommands: ['rm -rf .bridge-venv', 'python3 -m venv .bridge-venv']
  },
  mix: {
    label: 'Elixir project using mix',
    installCommand: 'mix deps.get',
    updateCommand: 'mix deps.update --all',
    cleanCommands: ['rm -rf deps', 'rm -rf _build', 'rm -f mix.lock']
  }
};

export const PACKAGE_MANAGER_OPTIONS = ['npm', 'yarn', 'pnpm', 'pip', 'mix'];

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
