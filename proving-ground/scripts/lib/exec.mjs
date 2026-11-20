// Thin async wrappers around external tools (git, gh). The orchestration scripts run
// in GitHub Actions where gh is authenticated via the ambient token; locally they use
// the operator's gh login. Nothing here runs package code.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function exec(file, args, { cwd, env, allowFailure = false, input } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      env: env || process.env,
      input,
      maxBuffer: 64 * 1024 * 1024
    });
    return { code: 0, stdout, stderr, success: true };
  } catch (error) {
    if (allowFailure) {
      return { code: error.code ?? 1, stdout: error.stdout || '', stderr: error.stderr || '', success: false };
    }
    throw new Error(`${file} ${args.join(' ')} failed (${error.code}): ${(error.stderr || error.message || '').toString().slice(0, 2000)}`);
  }
}

export const git = (args, opts) => exec('git', args, opts);
export const gh = (args, opts) => exec('gh', args, opts);

export async function ghJson(args, opts) {
  const result = await gh(args, opts);
  return JSON.parse(result.stdout || 'null');
}

export function log(message) {
  process.stdout.write(`${message}\n`);
}
