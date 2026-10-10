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

import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
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

// ── `/rc` inside the REPL: the same `adk rc`, held in the background ─────────
//
// Claude Code's /remote-control keeps the session you are IN reachable while you
// keep typing. `awsh rc` holds the foreground, which inside the REPL would freeze
// the prompt, so `/rc` runs the very same `adk rc` (same flags, same credential
// handling -- none of it is reimplemented here) as a child of this shell, relays
// its start-up output (device, sessions URL and the QR adk prints) until it says
// it is holding the link, then hands the prompt back. The link lives exactly as
// long as this shell, or until `/rc stop`.

/** Where this account's sessions are reachable while the link is held (adk prints it too). */
export const RC_SESSIONS_URL = 'https://api.aitherium.com/code';

/** The line `adk rc` prints once the link is up and it starts holding. */
export const RC_HOLDING_MARKER = 'Holding the link';

/** How long `/rc` relays start-up output before handing the prompt back anyway. */
export const RC_STARTUP_WAIT_MS = 120_000;

/** The slice of a ChildProcess this module uses (a fake in tests). */
export interface RcChild {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

export type RcSpawnBackground = (cmd: string, args: string[]) => RcChild;

export interface RcSession {
  child: RcChild;
  startedAt: number;
  state: 'starting' | 'holding' | 'exited';
  exitCode: number | null;
  /** adk's own output up to the holding line: device, URLs and the QR. */
  header: string[];
  /** Everything after it (reach changes), newest last, capped. */
  tail: string[];
  nodeId: string;
}

let current: RcSession | null = null;

/** The `/rc` session this shell holds, if any. */
export function currentRcSession(): RcSession | null {
  return current && current.state !== 'exited' ? current : null;
}

/** Forget any session (tests only). */
export function resetRcSessionForTests(): void {
  current = null;
}

const defaultSpawnBackground: RcSpawnBackground = (cmd, args) =>
  spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // adk prints the QR in block glyphs; a piped Python stdout on Windows is cp1252,
    // where the QR helper would (correctly) drop it. Ask for UTF-8 and no buffering
    // so the lines arrive as adk prints them.
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    // Own process group on POSIX so the REPL's Ctrl-C does not tear the link down
    // with the turn it meant to cancel; `/rc stop` signals the group.
    detached: process.platform !== 'win32',
    windowsHide: true,
  }) as unknown as RcChild;

export interface RcSlashDeps {
  spawnBackground?: RcSpawnBackground;
  runForeground?: (args: string[]) => number;
  kill?: (session: RcSession) => void;
  platform?: string;
  log?: (line: string) => void;
  now?: () => number;
  startupWaitMs?: number;
}

/** Split a chunked stream into whole lines. */
function onLines(stream: NodeJS.ReadableStream | null, cb: (line: string) => void): void {
  if (!stream) return;
  let buf = '';
  stream.on('data', (chunk: Buffer | string) => {
    buf += String(chunk);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      cb(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  });
  stream.on('end', () => { if (buf) cb(buf); buf = ''; });
}

/** Try each `adk` candidate; resolve with the child that actually started, or null. */
async function spawnFirst(
  args: string[], spawnBg: RcSpawnBackground, platform: string,
): Promise<RcChild | null> {
  for (const candidate of adkCandidates(platform)) {
    const child = await new Promise<RcChild | null>((resolveChild) => {
      let started: RcChild;
      try {
        started = spawnBg(candidate, ['rc', ...args]);
      } catch {
        resolveChild(null);
        return;
      }
      started.on('spawn', () => resolveChild(started));
      started.on('error', () => resolveChild(null));
    });
    if (child) return child;
  }
  return null;
}

/** Stop the held link: the whole process tree (Windows shims spawn the real python). */
function defaultKill(session: RcSession, platform: string = process.platform): void {
  const pid = session.child.pid;
  if (!pid) return;
  try {
    if (platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // adk rc treats SIGINT as Ctrl-C: it says "Stopped" and leaves the device enrolled.
      process.kill(-pid, 'SIGINT');
    }
  } catch {
    // already gone -- nothing to stop
  }
}

/** A line of adk's start-up block that belongs to the QR (block glyphs only). */
function isQrLine(line: string): boolean {
  return /[▀-▟]/.test(line) && !/[A-Za-z]/.test(line);
}

function printStatus(session: RcSession | null, log: (l: string) => void, now: number): void {
  if (!session) {
    log(`  ${chalk.dim('remote control is not running in this shell.')}`);
    log(`  ${chalk.cyan('/rc')} starts it   ·   ${chalk.cyan('/devices')} lists this account's devices`);
    return;
  }
  const mins = Math.max(0, Math.round((now - session.startedAt) / 60_000));
  const state = session.state === 'holding' ? chalk.green('holding the link') : chalk.yellow('starting');
  log(`  remote control: ${state}  (pid ${session.child.pid ?? '?'}, up ${mins} min)`);
  if (session.nodeId) log(`  device:   ${session.nodeId}`);
  log(`  sessions: ${chalk.cyan(RC_SESSIONS_URL)}`);
  // adk's own start-up block carries the QR; re-show it so a phone can scan it now.
  for (const l of session.header.filter(isQrLine)) log(l);
  for (const l of session.tail.slice(-5)) log(`  ${chalk.dim(l.trim())}`);
  log(`  ${chalk.cyan('/rc stop')} drops the link (the device stays enrolled).`);
}

let exitHookInstalled = false;

/** Drop the link when the shell exits: it was promised for "while this shell runs". */
function ensureExitHook(kill: (s: RcSession) => void): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    const s = currentRcSession();
    if (s) kill(s);
  });
}

/**
 * `/rc [status|stop] [adk rc flags…]` from inside the REPL.
 *
 * - `/rc` with a session already held prints its status; otherwise it starts
 *   `adk rc <flags>` in the background, relays its start-up output (device line,
 *   sessions URL, QR) and returns once adk reports it is holding the link.
 * - `/rc status` / `/rc stop` report on / stop the session this shell holds.
 * - `/rc --once` and `/rc --help` exit on their own, so they run in the foreground
 *   exactly as `awsh rc` does.
 *
 * Returns an exit-style code: 0 ok, non-zero adk's own (its output says why),
 * RC_MISSING_EXIT when there is no adk.
 */
export async function runRcSlash(argv: string[], deps: RcSlashDeps = {}): Promise<number> {
  const log = deps.log || ((line: string) => console.log(line));
  const platform = deps.platform || process.platform;
  const now = deps.now || Date.now;
  const kill = deps.kill || ((x: RcSession) => defaultKill(x, platform));
  const sub = (argv[0] || '').toLowerCase();

  if (sub === 'status') {
    printStatus(currentRcSession(), log, now());
    return 0;
  }
  if (sub === 'stop') {
    const s = currentRcSession();
    if (!s) {
      log(`  ${chalk.dim('remote control is not running in this shell.')}`);
      return 0;
    }
    kill(s);
    s.state = 'exited';
    current = null;
    log(`  ${chalk.green('✓')} remote control stopped. The device stays enrolled; ${chalk.cyan('/rc')} reconnects.`);
    return 0;
  }
  if (argv.includes('--once') || argv.includes('--help') || argv.includes('-h')) {
    return (deps.runForeground || ((a: string[]) => runRcCommand(a, { platform })))(argv);
  }
  const held = currentRcSession();
  if (held) {
    printStatus(held, log, now());
    return 0;
  }

  const child = await spawnFirst(argv, deps.spawnBackground || defaultSpawnBackground, platform);
  if (!child) {
    log(rcMissingMessage());
    return RC_MISSING_EXIT;
  }
  const session: RcSession = {
    child, startedAt: now(), state: 'starting', exitCode: null, header: [], tail: [], nodeId: '',
  };
  current = session;
  ensureExitHook(kill);

  const waitMs = deps.startupWaitMs ?? RC_STARTUP_WAIT_MS;
  return await new Promise<number>((resolveRc) => {
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveRc(code);
    };
    const timer = setTimeout(() => {
      log(`  ${chalk.dim('adk rc is still starting; it keeps going in the background -- /rc status')}`);
      finish(0);
    }, waitMs);
    const onLine = (line: string) => {
      if (session.state === 'holding' || done) {
        session.tail.push(line);
        if (session.tail.length > 50) session.tail.shift();
        return;
      }
      session.header.push(line);
      const dev = /^\s*Device:\s+(\S+)/.exec(line);
      if (dev) session.nodeId = dev[1];
      if (line.includes(RC_HOLDING_MARKER)) {
        session.state = 'holding';
        log(`  ${chalk.green('✓')} holding the link while this shell runs.  ${chalk.cyan('/rc status')} · ${chalk.cyan('/rc stop')}`);
        finish(0);
        return;
      }
      log(line);
    };
    onLines(child.stdout, onLine);
    onLines(child.stderr, onLine);
    child.on('exit', (code: number | null) => {
      session.state = 'exited';
      session.exitCode = code;
      if (current === session) current = null;
      if (!done) {
        // It ended before holding: adk said why above. The usual reason inside the
        // REPL is "not signed in" -- the device flow needs this terminal's stdin.
        if ((code ?? 1) !== 0) {
          log(`  ${chalk.yellow('adk rc stopped')} (exit ${code ?? '?'}). Not signed in? ${chalk.cyan('/link')} first, then ${chalk.cyan('/rc')}.`);
        }
        finish(code ?? 1);
      }
    });
  });
}
