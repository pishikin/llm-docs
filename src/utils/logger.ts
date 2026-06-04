import chalk from 'chalk';
import ora, { type Ora } from 'ora';

let verbose = false;
let quiet = false;

export function setLogLevel(opts: { verbose?: boolean; quiet?: boolean }): void {
  verbose = opts.verbose ?? false;
  quiet = opts.quiet ?? false;
}

export function info(msg: string): void {
  if (!quiet) console.log(chalk.blue('ℹ'), msg);
}

export function success(msg: string): void {
  if (!quiet) console.log(chalk.green('✔'), msg);
}

export function warn(msg: string): void {
  console.log(chalk.yellow('⚠'), msg);
}

export function error(msg: string): void {
  console.error(chalk.red('✖'), msg);
}

export function debug(msg: string): void {
  if (verbose) console.log(chalk.gray('⊡'), msg);
}

export function spinner(text: string): Ora {
  return ora({ text, isSilent: quiet });
}
