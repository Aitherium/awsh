/**
 * `aither awconnect [install|status|path] [flags…]` — the Awconnect browser
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
 *
 * Without awdk the answer is the one-line install, never a stack trace.
 */

import { spawnSync } from 'node:child_process';

/** Same rule as claude-command.ts's pythonExecutable, inlined so this module does
 *  not pull the TUI (chalk) in for a command that prints four lines. */
function pythonExecutable(env: NodeJS.ProcessEnv): string {
  return env.AITHER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export const AWCONNECT_ACTIONS = ['install', 'status', 'path'] as const;

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

/** The exact argv handed to python. Unknown first words are refused, not forwarded. */
export function buildAwconnectArgv(args: string[]): string[] | null {
  const rest = [...args];
  let action = 'status';
  if (rest.length && !rest[0].startsWith('-')) {
    const word = rest.shift()!.toLowerCase();
    if (!(AWCONNECT_ACTIONS as readonly string[]).includes(word)) return null;
    action = word;
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
