/**
 * `/packs` and `/skills <verb>` — add-on discovery and install, delegated to `adk`.
 *
 * A THIN shell-out to `python -m adk.cli pack|skills …` (same pattern as
 * awconnect-command.ts). awdk's resolver (adk.addons) owns resolution across
 * awpack, Library packs, awnode extensions and awskills, the brick calls, the
 * approval rules and the one lock record; a second implementation here would
 * drift from the one `adk`, the agent `install_pack` tool and the desk call.
 *
 *   /packs search <query>      every source, one table
 *   /packs install <id> [--allow-community]
 *   /packs enable <id>         install if missing, then turn it on
 *   /packs update [id]         every installed add-on, or one
 *   /packs remove <id>
 *   /packs info <id>
 *   /skills search|install|update|remove <name> [--target claude|project|adk]
 *
 * Exit codes ride on the return value: adk's own status, 2 for a refused verb,
 * 3 when awdk is not installed (the answer is the install line, never a trace).
 */

import { spawnSync } from 'node:child_process';

function pythonExecutable(env: NodeJS.ProcessEnv): string {
  return env.AITHER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export const PACK_VERBS = ['search', 'install', 'enable', 'disable', 'update', 'remove', 'info', 'list'] as const;
/** UX law 4: a visible list shows five, then `+N more`. */
export const EXPLORE_CAP = 5;
export const SKILL_VERBS = ['search', 'install', 'update', 'remove', 'list'] as const;
/** `uninstall` is Hermes's word for remove; accept it so the verbs read the same. */
const VERB_ALIASES: Record<string, string> = { uninstall: 'remove', add: 'install', find: 'search' };

export const AWDK_INSTALL_HINT = process.platform === 'win32'
  ? 'powershell -ExecutionPolicy ByPass -c "irm https://aitherium.com/install.ps1 | iex"'
  : 'curl -fsSL https://aitherium.com/install.sh | sh';

export interface PacksDeps {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Run python with argv, stdio inherited. Exit status, or null = could not start. */
  runPython?: (argv: string[]) => number | null;
  /** Run python with argv, stdout captured. */
  capturePython?: (argv: string[]) => { status: number | null; stdout: string; stderr: string };
  /** Can python import adk's add-on resolver? */
  adkReady?: () => boolean;
}

/** The exact argv for `python`, or null for a verb adk does not have. */
export function buildPacksArgv(noun: 'pack' | 'skills', args: string[]): string[] | null {
  const rest = [...args];
  if (!rest.length) return noun === 'pack' ? ['-m', 'adk.cli', 'pack', 'list'] : null;
  let verb = rest.shift()!.toLowerCase();
  verb = VERB_ALIASES[verb] || verb;
  const verbs: readonly string[] = noun === 'pack' ? PACK_VERBS : SKILL_VERBS;
  if (!verbs.includes(verb)) return null;
  const needsId = !['list', 'update', 'search'].includes(verb) ||
    (noun === 'skills' && verb === 'update');
  if (needsId && !rest.find((a) => !a.startsWith('-'))) return null;
  return ['-m', 'adk.cli', noun, verb, ...rest];
}

export function packsUsage(): string {
  return [
    '/packs — find and install add-ons (awpack, Library, awnode ext) via adk',
    '',
    '  /packs search <query>                      every source, one table',
    '  /packs install <id> [--allow-community]    resolve, install through its brick, record',
    '  /packs enable <id>                         install if missing, then turn it on',
    '  /packs update [id]                         every installed add-on, or one',
    '  /packs remove <id>',
    '  /packs info <id>',
    '  /skills search|install|update|remove <name> [--target claude|project|adk]',
  ].join('\n');
}

function defaultAdkReady(env: NodeJS.ProcessEnv) {
  return (): boolean => {
    const r = spawnSync(pythonExecutable(env), ['-c', 'import adk.addons'], {
      stdio: 'ignore', env, timeout: 30_000, windowsHide: true,
    });
    return !r.error && r.status === 0;
  };
}

function defaultRunPython(env: NodeJS.ProcessEnv) {
  return (argv: string[]): number | null => {
    const r = spawnSync(pythonExecutable(env), argv, { stdio: 'inherit', env, windowsHide: true });
    return r.error ? null : r.status;
  };
}

function defaultCapturePython(env: NodeJS.ProcessEnv) {
  return (argv: string[]) => {
    const r = spawnSync(pythonExecutable(env), argv, {
      encoding: 'utf-8', env, timeout: 120_000, windowsHide: true,
    });
    return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

function notInstalled(log: (l: string) => void): number {
  log('awdk with the add-on resolver (adk.addons) is not installed for this python. Install or upgrade it:');
  log(`  ${AWDK_INSTALL_HINT}`);
  log('  (or: pip install -U awdk)');
  return 3;
}

export function runPacksCommand(noun: 'pack' | 'skills', args: string[], deps: PacksDeps = {}): number {
  const env = deps.env || process.env;
  const log = deps.log || ((line: string) => console.log(line));
  if (args[0] && ['-h', '--help', 'help'].includes(args[0])) {
    log(packsUsage());
    return 0;
  }
  const argv = buildPacksArgv(noun, args);
  if (!argv) {
    log(packsUsage());
    return 2;
  }
  if (!(deps.adkReady || defaultAdkReady(env))()) return notInstalled(log);
  const status = (deps.runPython || defaultRunPython(env))(argv);
  return status === null ? 3 : status;
}

/**
 * /explore with no catalog: ask the installed adk (`adk pack search --json`), which
 * reads Genesis, the catalog bundled with awdk, the awpack shelf and awnode ext.
 * Returns the exit code: 0 with results, 1 with the reason when nothing answers.
 */
export function exploreViaAdk(query: string, deps: PacksDeps = {}): number {
  const env = deps.env || process.env;
  const log = deps.log || ((line: string) => console.log(line));
  const reason = 'No catalog: Genesis did not answer /api/v1/catalog/packs and no packs_catalog.json was found';
  if (!(deps.adkReady || defaultAdkReady(env))()) {
    log(`  ${reason}, and awdk is not installed to search locally.`);
    notInstalled((l) => log(`  ${l}`));
    return 1;
  }
  const r = (deps.capturePython || defaultCapturePython(env))(
    ['-m', 'adk.cli', 'pack', 'search', query, '--json']);
  let data: any = null;
  try { data = JSON.parse(r.stdout); } catch { data = null; }
  if (r.status !== 0 || !data) {
    log(`  ${reason}; \`adk pack search\` failed too (exit ${r.status ?? 'none'}).`);
    const tail = (r.stderr || '').trim().split('\n').slice(-2).join(' ');
    if (tail) log(`  ${tail}`);
    return 1;
  }
  const packs: any[] = Array.isArray(data.packs) ? data.packs : [];
  for (const [kind, why] of Object.entries(data.unavailable || {})) log(`  (${kind} unavailable: ${why})`);
  if (!packs.length) {
    log(`  ${reason}; adk searched every source and found nothing${query ? ` for "${query}"` : ''}.`);
    return 1;
  }
  log(`\n  ${packs.length} add-on(s) via adk (Genesis catalog unreachable):\n`);
  // Cap the visible list at five; the count is the real total and the rest is one verb away.
  for (const p of packs.slice(0, EXPLORE_CAP)) {
    const status = p.installed ? 'installed' : 'available';
    log(`  ${String(p.kind).padEnd(11)} ${String(p.id).padEnd(24)} ${String(p.trust).padEnd(10)} ${status}`);
  }
  if (packs.length > EXPLORE_CAP) {
    log(`  +${packs.length - EXPLORE_CAP} more — /packs search ${query || '<query>'}`);
  }
  log('\n  Next: /packs install <id>');
  return 0;
}

/** Split a slash-command tail on whitespace, keeping "double quoted" words whole. */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args || '')) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}
