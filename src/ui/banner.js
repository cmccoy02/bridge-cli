import chalk from 'chalk';

const BANNER = String.raw`
  ____  ____  ___ ____   ____ _____
 | __ )|  _ \|_ _|  _ \ / ___| ____|
 |  _ \| |_) || || | | | |  _|  _|
 | |_) |  _ < | || |_| | |_| | |___
 |____/|_| \_\___|____/ \____|_____|
`;

export function printBanner() {
  console.log(chalk.cyan(BANNER));
}
