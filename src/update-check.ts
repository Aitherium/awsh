/**
 * update-check.ts -- once a day, ask the npm registry whether a newer
 * @aitherium/awsh exists, and say so in one line.
 *
 * awsh had no update check at all: an install stayed on whatever version it
 * was set up with, and nothing ever said a release existed. The fix has three
 * constraints that shape everything below:
 *
 *  - Never slow a command down. The lookup runs in a DETACHED child process
 *    that writes the cache and exits; this process never waits for it, and
 *    the NEXT start prints the answer. Not an in-process request with an
 *    unref'd socket: measured 2026-10-07 on Windows/Node 25, a request to an
 *    unreachable host held process exit for 21s with `socket.unref()` applied
 *    (a pending libuv connect is a request, not a handle, and unref cannot
 *    touch it). The bun-compiled binary cannot `-e` a script, so it looks up
 *    in-process with a hard FETCH_TIMEOUT_MS cap instead.
 *  - Never nag. The notice prints at most once per CHECK_INTERVAL_MS, only to
 *    an interactive stderr, and only when the registry is strictly newer (a dev
 *    build ahead of npm is never told to "update" to an older release). A
 *    failed lookup is not retried until the interval passes either.
 *  - Say the command that works for THIS install. `npm i -g` is wrong for the
 *    bun-compiled binary, Homebrew and winget, so the install method is
 *    detected from where the running script lives.
 *
 * Off with AWSH_NO_UPDATE_CHECK=1 (or the family-wide AITHER_NO_UPDATE_CHECK=1),
 * and whenever the shell is offline (AITHER_OFFLINE=1 / `offline: true`).
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const PACKAGE = '@aitherium/awsh';
export const REGISTRY_URL = 'https://registry.npmjs.org/@aitherium%2Fawsh/latest';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;
const TRUE = new Set(['1', 'true', 'yes', 'on']);

export type InstallMethod =
  'npm' | 'pnpm' | 'yarn' | 'bun' | 'brew' | 'winget' | 'binary' | 'source';

export interface UpdateCache {
  /** Newest version the registry reported; '' until a lookup has succeeded. */
  latest: string;
  /** Last successful lookup. */
  checkedAt: number;
  /** Last lookup STARTED, success or not -- what rate-limits lookups. */
  attemptedAt?: number;
  /** When the notice last printed; it prints at most once per CHECK_INTERVAL_MS. */
  notifiedAt?: number;
}

export function cachePath(home: string = homedir()): string {
  return join(home, '.aither', 'update-check-awsh.json');
}

export function updateCheckDisabled(env: NodeJS.ProcessEnv, offline: boolean): boolean {
  if (offline) return true;
  return ['AWSH_NO_UPDATE_CHECK', 'AITHER_NO_UPDATE_CHECK']
    .some((k) => TRUE.has((env[k] || '').trim().toLowerCase()));
}

function parts(v: string): number[] {
  const clean = v.trim().replace(/^v/, '').split(/[-+]/)[0];
  const out: number[] = [];
  for (const p of clean.split('.')) {
    const n = Number.parseInt(p, 10);
    if (Number.isNaN(n)) break;
    out.push(n);
  }
  return out;
}

/** True only when `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  if (!latest || !current) return false;
  const a = parts(latest), b = parts(current);
  if (!a.length || !b.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * How this copy of awsh was installed, from where its entry script and runtime
 * live. `compiled` = running as a bun --compile single-file executable.
 */
export function detectInstallMethod(o: {
  scriptPath: string; execPath: string; compiled: boolean;
}): InstallMethod {
  const exe = o.execPath.replace(/\\/g, '/').toLowerCase();
  const script = o.scriptPath.replace(/\\/g, '/').toLowerCase();
  if (o.compiled) {
    if (exe.includes('/cellar/') || exe.includes('/homebrew/')) return 'brew';
    if (exe.includes('/winget/')) return 'winget';
    return 'binary';
  }
  if (!script.includes('/node_modules/')) return 'source';
  if (script.includes('/pnpm/')) return 'pnpm';
  if (script.includes('/.bun/install/')) return 'bun';
  if (script.includes('/yarn/')) return 'yarn';
  return 'npm';
}

/** The upgrade command for an install method, or null where none is ours to give. */
export function upgradeCommand(method: InstallMethod, latest: string): string | null {
  switch (method) {
    case 'npm': return `npm i -g ${PACKAGE}@latest`;
    case 'pnpm': return `pnpm add -g ${PACKAGE}@latest`;
    case 'yarn': return `yarn global add ${PACKAGE}@latest`;
    case 'bun': return `bun add -g ${PACKAGE}@latest`;
    case 'brew': return 'brew upgrade awsh';
    case 'winget': return 'winget upgrade Aitherium.AitherShell';
    case 'binary':
      return `download shell-v${latest} from https://github.com/Aitherium/awdk/releases`;
    // A source checkout updates with git; a release notice there is noise.
    case 'source': return null;
  }
}

export function readCache(path: string): UpdateCache | null {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof c?.latest === 'string' && typeof c?.checkedAt === 'number') return c;
  } catch { /* absent or unreadable: treat as never checked */ }
  return null;
}

export function writeCache(path: string, c: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(c), 'utf8');
  } catch { /* a read-only home just means checking again next time */ }
}

/** Merge a successful lookup into the cache, keeping notifiedAt/attemptedAt. */
export function recordLatest(path: string, latest: string, now: number = Date.now()): void {
  writeCache(path, { ...(readCache(path) ?? {}), latest, checkedAt: now });
}

/**
 * GET the registry's `latest` manifest in-process; resolves the version or
 * null, and gives up after `timeoutMs` (destroying the request is what lets
 * the process exit -- see the header).
 */
export function fetchLatest(url: string = REGISTRY_URL,
  timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = request(url, { headers: { accept: 'application/json' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); finish(null); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { finish(String(JSON.parse(body).version || '') || null); } catch { finish(null); }
        });
        res.on('error', () => finish(null));
      });
      const cap = setTimeout(() => { req.destroy(); finish(null); }, timeoutMs);
      cap.unref();
      req.on('close', () => clearTimeout(cap));
      req.on('socket', (s) => s.unref());
      req.on('error', () => finish(null));
      req.end();
    } catch {
      finish(null);
    }
  });
}

/**
 * The detached lookup: a tiny CommonJS script run by this same `node`, with
 * the registry URL and cache file as argv. It writes the cache on success and
 * exits; stdio is ignored and the child is unref'd, so the shell never waits.
 */
export const CHILD_SCRIPT = [
  "const fs=require('fs'),path=require('path');",
  'const [url,file]=process.argv.slice(1);',
  // Always https in use (REGISTRY_URL); plain http only so a test can serve it.
  "const req=require(url.startsWith('http:')?'http':'https').get(url,{headers:{accept:'application/json'},timeout:10000},(r)=>{",
  "let b='';r.setEncoding('utf8');r.on('data',(c)=>{b+=c;});r.on('end',()=>{try{",
  'const v=r.statusCode===200&&String(JSON.parse(b).version||"");if(!v)return;',
  "let c={};try{c=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}",
  'fs.mkdirSync(path.dirname(file),{recursive:true});',
  'fs.writeFileSync(file,JSON.stringify({...c,latest:v,checkedAt:Date.now()}));',
  '}catch{}});});',
  "req.on('timeout',()=>req.destroy());req.on('error',()=>{});",
].join('');

function spawnLookup(file: string, url: string = REGISTRY_URL): void {
  const child = spawn(process.execPath, ['-e', CHILD_SCRIPT, url, file], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

export interface UpdateCheckOptions {
  current: string;
  method: InstallMethod;
  cacheFile?: string;
  now?: number;
  /** In-process lookup (tests; the compiled binary). Omitted = detached child. */
  fetcher?: () => Promise<string | null>;
}

/**
 * The startup hook. Returns the one-line notice to print now (from the cache),
 * or null, and starts a background lookup when the last one is a day old.
 * Never throws and never waits on the network. `refresh` is an in-process
 * lookup it started, for callers (tests) that want to await it.
 */
export function checkForUpdate(o: UpdateCheckOptions): { notice: string | null; refresh?: Promise<void> } {
  try {
    const file = o.cacheFile ?? cachePath();
    const now = o.now ?? Date.now();
    let cached = readCache(file);
    let refresh: Promise<void> | undefined;
    const lastTry = Math.max(cached?.checkedAt ?? 0, cached?.attemptedAt ?? 0);
    if (now - lastTry >= CHECK_INTERVAL_MS) {
      // Stamp the attempt first: a failing network then costs one lookup a
      // day, not one per command.
      cached = { latest: '', checkedAt: 0, ...(cached ?? {}), attemptedAt: now };
      writeCache(file, cached);
      if (o.fetcher) {
        refresh = o.fetcher()
          .then((latest) => { if (latest) recordLatest(file, latest); })
          .catch(() => {});
      } else {
        spawnLookup(file);
      }
    }
    if (!cached || !isNewer(cached.latest, o.current)) return { notice: null, refresh };
    if (cached.notifiedAt && now - cached.notifiedAt < CHECK_INTERVAL_MS) return { notice: null, refresh };
    const cmd = upgradeCommand(o.method, cached.latest);
    if (!cmd) return { notice: null, refresh };
    writeCache(file, { ...cached, notifiedAt: now });
    return {
      notice: `awsh ${cached.latest} is available (you have ${o.current}). Update: ${cmd}`,
      refresh,
    };
  } catch {
    return { notice: null };
  }
}

/** Whether this process is a bun --compile executable (no `-e`, no node). */
export function isCompiledBinary(): boolean {
  const bun = (globalThis as { Bun?: unknown }).Bun !== undefined;
  // A compiled executable IS its own runtime: execPath is the awsh binary,
  // not a `bun` interpreter.
  return bun && !/^bun(\.exe)?$/i.test(basename(process.execPath));
}

/** The install method of the running process. */
export function currentInstallMethod(): InstallMethod {
  return detectInstallMethod({
    scriptPath: process.argv[1] || '',
    execPath: process.execPath,
    compiled: isCompiledBinary(),
  });
}
