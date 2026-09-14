/**
 * `awsh rc` — remote control: make THIS machine reachable from your phone.
 *
 * It is an ALIAS, not a second implementation. `adk rc` (awdk) already signs the
 * machine in, enrols it, holds the outbound reverse link to the tunnel and
 * advertises the local session daemon with a per-node scoped token. Re-writing
 * any of that here would be a second thing to keep correct, and the credential
 * handling is the half that must never drift.
 *
 * Why the alias exists at all: the "+ Add device" screen on aitherium.com shows
 * ONE paste-able command, and on a machine that has awsh the command a person
 * already has in their hands is `awsh`. Telling them to install a Python package
 * first is a second door for a thing this shell can already reach (OFD).
 *
 * When `adk` is NOT on PATH this prints exactly `pip install awdk && adk rc` and
 * exits 2 — a NAMED refusal rather than a spawn error. `ENOENT` from a child
 * process reads as "awsh is broken"; the line above reads as "install this".
 * Exit 2 is "could not run", which is this repo's convention everywhere else and
 * is distinguishable from `adk rc` itself failing (its own non-zero code).
 *
 * Flags are forwarded VERBATIM — `--node-class`, `--harness-url`,
 * `--token-ttl-days`, `--api-key`, `--once`, `--help`. awdk's argparse is the
 * only validator; a copy of its flag table here would be wrong the first time
 * awdk added one.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import chalk from 'chalk';

/** What we exit with when `adk` cannot be found. Not 1: this is "could not run". */
export const RC_MISSING_EXIT = 2;

/** The exact line a person may copy. Keep the literal — the sheet on the web shows it too. */
export const RC_INSTALL_LINE = 'pip install awdk && adk rc';

/** Candidate executables, in order. Windows needs the `.exe` shim name first. */
export function adkCandidates(platform: string = process.platform): string[] {
  return platform === 'win32' ? ['adk.exe', 'adk'] : ['adk'];
}

/** The message printed when nothing named `adk` answers. */
export function rcMissingMessage(): string {
  return [
    `  ${chalk.yellow('awsh rc')} needs awdk — the same verb, in Python.`,
    '',
    `    ${RC_INSTALL_LINE}`,
    '',
    '  It enrols this machine and holds the link, so its sessions show up',
    '  at api.aitherium.com/code while it runs.',
  ].join('\n');
}

type Spawn = (cmd: string, args: string[]) => SpawnSyncReturns<Buffer>;

const defaultSpawn: Spawn = (cmd, args) =>
  spawnSync(cmd, args, { stdio: 'inherit' }) as SpawnSyncReturns<Buffer>;

export interface RcDeps {
  spawn?: Spawn;
  platform?: string;
  log?: (line: string) => void;
}

/**
 * Run `adk rc …`, or explain how to get it.
 *
 * Returns the child's exit code, or RC_MISSING_EXIT when no candidate ran. A
 * spawn that fails with an error (ENOENT and friends) is treated as "this
 * candidate is not here" and the next one is tried — never as a crash.
 */
export function runRcCommand(args: string[], deps: RcDeps = {}): number {
  const spawn = deps.spawn || defaultSpawn;
  const log = deps.log || ((line: string) => console.error(line));

  for (const candidate of adkCandidates(deps.platform)) {
    const result = spawn(candidate, ['rc', ...args]);
    if (result && !result.error) return result.status ?? 0;
  }

  log(rcMissingMessage());
  return RC_MISSING_EXIT;
}
