import chalk from 'chalk';

export function line(message = '') {
  console.log(message);
}

export function info(message) {
  console.log(message);
}

export function success(message) {
  console.log(`${chalk.cyan('✓')} ${message}`);
}

export function warn(message) {
  console.log(chalk.yellow(`! ${message}`));
}

export function error(message) {
  console.error(chalk.red(`✖ ${message}`));
}

export function section(title) {
  console.log(`\n${title}`);
}

export function command(message) {
  console.log(chalk.dim(`> ${message}`));
}
