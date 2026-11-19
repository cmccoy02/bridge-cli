import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export class CommandExecutionError extends Error {
  constructor(command, result) {
    super(`Command failed: ${command}`);
    this.name = 'CommandExecutionError';
    this.command = command;
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

// Credentials Bridge itself uses (GitHub tokens, the Actions OIDC request token,
// Bridge cloud tokens). Package scripts never need them, so they are removed from
// the environment of every command unless the caller marks it `trusted`.
const SCRUBBED_ENV_NAMES = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
  'ACTIONS_CACHE_URL',
  'ACTIONS_RESULTS_URL'
]);
const SCRUBBED_ENV_PATTERNS = [/^BRIDGE_[A-Z0-9_]*(TOKEN|SECRET|KEY|PASSWORD)$/];

let untrustedEnvAllowlist = new Set();

/**
 * Lets a project opt specific variables back in (config `env.allow`), e.g. a build
 * that genuinely needs GITHUB_TOKEN to download a release asset.
 */
export function configureUntrustedEnv({ allow = [] } = {}) {
  untrustedEnvAllowlist = new Set(
    (Array.isArray(allow) ? allow : [])
      .map((name) => String(name || '').trim().toUpperCase())
      .filter(Boolean)
  );
}

export function isScrubbedEnvName(name) {
  const upper = String(name || '').toUpperCase();

  if (untrustedEnvAllowlist.has(upper)) {
    return false;
  }

  return SCRUBBED_ENV_NAMES.has(upper) || SCRUBBED_ENV_PATTERNS.some((pattern) => pattern.test(upper));
}

export function buildUntrustedEnv(env = process.env) {
  const childEnv = {};

  for (const [name, value] of Object.entries(env || {})) {
    if (value === undefined || isScrubbedEnvName(name)) {
      continue;
    }

    childEnv[name] = value;
  }

  return childEnv;
}

export function runCommand(
  command,
  {
    cwd = process.cwd(),
    allowFailure = false,
    quiet = true,
    env = process.env,
    trusted = false
  } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: trusted ? env : buildUntrustedEnv(env),
      shell: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;

      if (!quiet) {
        process.stdout.write(text);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;

      if (!quiet) {
        process.stderr.write(text);
      }
    });

    child.on('error', (error) => {
      const result = {
        command,
        code: 1,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        success: false
      };

      if (allowFailure) {
        resolve(result);
        return;
      }

      reject(new CommandExecutionError(command, result));
    });

    child.on('close', (code) => {
      const result = {
        command,
        code: code ?? 1,
        stdout,
        stderr,
        success: code === 0
      };

      if (result.success || allowFailure) {
        resolve(result);
        return;
      }

      reject(new CommandExecutionError(command, result));
    });
  });
}

export async function runCommands(commands, options = {}) {
  for (const command of commands) {
    await runCommand(command, options);
  }
}

export async function commandExists(commandName) {
  const candidate = String(commandName || '').trim();

  if (!candidate || candidate.includes('\0')) {
    return false;
  }

  const extensions =
    process.platform === 'win32'
      ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  const candidates = candidate.includes(path.sep)
    ? [path.resolve(candidate)]
    : String(process.env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((directory) =>
          extensions.map((extension) => path.join(directory, `${candidate}${extension}`))
        );

  for (const executablePath of candidates) {
    try {
      await fs.access(executablePath, process.platform === 'win32' ? undefined : 1);
      return true;
    } catch {
      // Keep looking through PATH.
    }
  }

  return false;
}
