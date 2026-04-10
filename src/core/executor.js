import { spawn } from 'node:child_process';

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

export function runCommand(
  command,
  { cwd = process.cwd(), allowFailure = false, quiet = true, env = process.env } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
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
  const result = await runCommand(`command -v ${commandName}`, {
    allowFailure: true,
    quiet: true
  });

  return result.success;
}
