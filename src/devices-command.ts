/**
 * `/devices` — this account's devices, and adding one, from inside the shell.
 *
 * Like `/rc`, an ALIAS for the awdk verb, not a second implementation:
 *
 *   /devices            -> adk devices list
 *   /devices add        -> adk devices add   (mints a single-use pairing code bound to
 *                          you, prints it with `adk pair <code>`, a QR of the installer
 *                          link for a phone or Steam Deck, and waits for the device)
 *   /devices <verb> ... -> adk devices <verb> ...   (status, rm, command, command-log)
 *
 * The sign-in, the Identity calls and the refusals (402 subscription, 403 device cap)
 * live in awdk's `adk devices`; its argparse is the only validator, so flags are
 * forwarded verbatim. Without `adk` on PATH this prints the install line and returns 2,
 * the same named refusal `awsh rc` gives.
 */

import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { adkCandidates, RC_MISSING_EXIT } from './rc-command.js';

/** The line to copy when awdk is missing. */
export const DEVICES_INSTALL_LINE = 'pip install awdk && adk devices';

/** `adk devices` argv for what the person typed after `/devices`. */
export function devicesArgv(argv: string[]): string[] {
  return ['devices', ...(argv.length ? argv : ['list'])];
}

export type DevicesSpawn = (cmd: string, args: string[]) => Promise<number | null>;

const defaultSpawn: DevicesSpawn = (cmd, args) => new Promise((resolveCode) => {
  const child = spawn(cmd, args, {
    stdio: 'inherit',
    shell: false,
    // the QR is block glyphs; keep a redirected Python stdout able to print it
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  child.on('error', () => resolveCode(null));          // not installed / not on PATH
  child.on('close', (code) => resolveCode(code ?? 1));
});

export interface DevicesDeps {
  spawn?: DevicesSpawn;
  platform?: string;
  log?: (line: string) => void;
}

/** Run `adk devices …`; returns its exit code, or RC_MISSING_EXIT without awdk. */
export async function runDevicesCommand(argv: string[], deps: DevicesDeps = {}): Promise<number> {
  const run = deps.spawn || defaultSpawn;
  const log = deps.log || ((line: string) => console.log(line));
  for (const candidate of adkCandidates(deps.platform)) {
    const code = await run(candidate, devicesArgv(argv));
    if (code !== null) return code;
  }
  log(`  ${chalk.yellow('/devices')} needs awdk — the same verb, in Python.`);
  log('');
  log(`    ${DEVICES_INSTALL_LINE}`);
  return RC_MISSING_EXIT;
}
