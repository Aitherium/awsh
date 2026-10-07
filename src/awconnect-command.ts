/**
 * `aither awconnect [install|status|path|pair] [flags…]` — the Awconnect browser
 * extension, from the terminal.
 *
 * A THIN shell-out to `python -m adk.cli awconnect …` (same pattern as
 * `aither claude` and the licensing half of `aither shop`): awdk owns staging
 * (~/.aither/awconnect/current), the verified release download, browser
 * detection and the read-only profile scan. A second implementation here would
 * drift from the one awdesk's tray calls.
 *
 *   aither awconnect                 status (the default)
 *   aither awconnect install         stage it, open chrome://extensions, copy the
 *                                    folder path, watch for the load (120 s)
 *   aither awconnect install --update   refresh the folder in place
 *   aither awconnect status --json
 *   aither awconnect path
 *   aither awconnect pair            pending pairing requests (the default)
 *   aither awconnect pair approve <code>   approve the 6-digit code the extension shows
 *   aither awconnect pair revoke     revoke every paired extension token
 *
 * Without awdk the answer is the one-line install, never a stack trace.
 */

import { spawnSync } from 'node:child_process';

/** Same rule as claude-command.ts's pythonExecutable, inlined so this module does
 *  not pull the TUI (chalk) in for a command that prints four lines. */
function pythonExecutable(env: NodeJS.ProcessEnv): string {
  return env.AITHER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export const AWCONNECT_ACTIONS = ['install', 'status', 'path', 'pair'] as const;
/** `adk awconnect pair`'s own subcommands (its argparse choices). */
export const AWCONNECT_PAIR_ACTIONS = ['pending', 'approve', 'revoke'] as const;

/** The Chrome Web Store listing: the one-click install for everyone else. */
export const AWCONNECT_WEBSTORE_URL =
  'https://chromewebstore.google.com/detail/awconnect/peeojgjhjficedkncdejbfnacooodbak';

export const AWDK_INSTALL_HINT = process.platform === 'win32'
  ? 'powershell -ExecutionPolicy ByPass -c "irm https://aitherium.com/install.ps1 | iex"'
  : 'curl -fsSL https://aitherium.com/install.sh | sh';

export interface AwconnectDeps {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Run python with argv; stdio inherited. Returns the exit status (null = could not start). */
  runPython?: (argv: string[]) => number | null;
  /** Can python import adk's awconnect module? (false = no awdk, or one too old). */
  adkReady?: () => boolean;
}

/** `pair`'s argv tail, or null. Stricter than the other verbs because this one
 *  hands the daemon an OWNER approval: exactly `[pending|revoke]` or
 *  `approve <6 digits>` (spaces/dashes in the code are dropped, as people copy
 *  it as "123 456"), and nothing else -- no flag is forwarded. */
function pairArgv(rest: string[]): string[] | null {
  if (!rest.length) return ['pending'];
  const sub = rest[0].toLowerCase();
  if (!(AWCONNECT_PAIR_ACTIONS as readonly string[]).includes(sub)) return null;
  if (sub !== 'approve') return rest.length === 1 ? [sub] : null;
  const code = rest.slice(1).join('').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(code) ? ['approve', code] : null;
}

/** The exact argv handed to python. Unknown first words are refused, not forwarded. */
export function buildAwconnectArgv(args: string[]): string[] | null {
  const rest = [...args];
  let action = 'status';
  if (rest.length && !rest[0].startsWith('-')) {
    const word = rest.shift()!.toLowerCase();
    if (!(AWCONNECT_ACTIONS as readonly string[]).includes(word)) return null;
    action = word;
  }
  if (action === 'pair') {
    const tail = pairArgv(rest);
    return tail ? ['-m', 'adk.cli', 'awconnect', 'pair', ...tail] : null;
  }
  return ['-m', 'adk.cli', 'awconnect', action, ...rest];
}

export function awconnectUsage(): string {
  return [
    'aither awconnect — set up the Awconnect browser extension (via awdk)',
    '',
    '  aither awconnect status [--json]     is it loaded, enabled and current? (default)',
    '  aither awconnect install [--browser chrome|edge|brave] [--wait N] [--no-open]',
    '                                       stage it, open the extensions page, copy the',
    '                                       folder path, then watch for the load',
    '  aither awconnect install --update    refresh the loaded folder in place',
    '  aither awconnect path                the folder to "Load unpacked"',
    '  aither awconnect pair [pending]      pairing requests waiting for your approval',
    '  aither awconnect pair approve <code> approve the 6-digit code the extension shows',
    '  aither awconnect pair revoke         revoke every paired extension token',
    '',
    `  One-click install: ${AWCONNECT_WEBSTORE_URL}`,
    '  (install stages the developer build for "Load unpacked")',
  ].join('\n');
}

function defaultAdkReady(env: NodeJS.ProcessEnv) {
  return (): boolean => {
    const r = spawnSync(pythonExecutable(env), ['-c', 'import adk.awconnect_setup'], {
      stdio: 'ignore', env, timeout: 30_000,
    });
    return !r.error && r.status === 0;
  };
}

function defaultRunPython(env: NodeJS.ProcessEnv) {
  return (argv: string[]): number | null => {
    const r = spawnSync(pythonExecutable(env), argv, { stdio: 'inherit', env });
    return r.error ? null : r.status;
  };
}

export function runAwconnectCommand(args: string[], deps: AwconnectDeps = {}): number {
  const env = deps.env || process.env;
  const log = deps.log || ((line: string) => console.log(line));
  if (args[0] && ['-h', '--help', 'help'].includes(args[0])) {
    log(awconnectUsage());
    return 0;
  }
  const argv = buildAwconnectArgv(args);
  if (!argv) {
    log(awconnectUsage());
    return 2;
  }
  if (!(deps.adkReady || defaultAdkReady(env))()) {
    log('awdk with `adk awconnect` is not installed for this python. Install or upgrade it:');
    log(`  ${AWDK_INSTALL_HINT}`);
    log('  (or: pip install -U awdk)');
    return 3;
  }
  const status = (deps.runPython || defaultRunPython(env))(argv);
  return status === null ? 3 : status;
}
