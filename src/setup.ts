/**
 * `awsh setup` -- make the shell actually work on this machine, and PROVE it.
 *
 * Every failure this exists for was SILENT. Measured 2026-08-21 on a real
 * install, in the order a user hits them:
 *
 *   1. The shim was placed in a directory that was on `$env:PATH` in the
 *      installing process and in NEITHER persisted PATH. `awsh` did not resolve
 *      in a new terminal, and the omnibox hook -- whose guard is
 *      `Get-Command awsh ... -ErrorAction SilentlyContinue` -- fell back to the
 *      ordinary "not recognized" error. Indistinguishable from not installed.
 *   2. Controlled Folder Access made ~/Documents unwritable, so writing the
 *      PowerShell profile REPORTED SUCCESS and changed nothing. Two installs
 *      were confirmed done before anyone read the file back.
 *   3. The configured endpoint served an HTML page on /v1, so the shell showed
 *      "(no response)" with no reason.
 *   4. Pack discovery followed a stale env pointer at another drive, so real
 *      packs were invisible and typing one got a guess from the agent.
 *
 * The rule this module is built on: **every step verifies by observing the
 * result, never by trusting the call that produced it.** A write that returns
 * without throwing is not a write; a PATH entry in this process is not a PATH
 * entry; an endpoint that returns 200 is not an inference endpoint.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export type StepState = 'ok' | 'fixed' | 'failed' | 'skipped';

export interface StepResult {
  name: string;
  state: StepState;
  detail: string;
}

/** Is `dir` on the PERSISTED PATH -- the one a NEW terminal inherits?
 *
 *  Never `process.env.PATH`: this process inherits entries from whatever
 *  launched it, and that is precisely how a shim was installed somewhere no
 *  real terminal could see. */
/** Trailing path separators, either slash.
 *
 * Built from a char code rather than written as a literal: the obvious form
 * `/[\/]+$/` loses its escape every time this file is edited through a shell
 * heredoc, and the result -- a class holding ONLY the forward slash -- still
 * compiles, still runs, and silently stops stripping the separator Windows
 * actually uses. The test for it failed on exactly that.
 */
const TRAILING_SEP = new RegExp('[' + String.fromCharCode(92) + String.fromCharCode(92) + '/]+$');

export function onPersistedPath(dir: string, machine: string, user: string): boolean {
  const want = dir.replace(TRAILING_SEP, '').toLowerCase();
  return (machine + ';' + user)
    .split(';')
    .map((e) => e.trim().replace(TRAILING_SEP, '').toLowerCase())
    .filter(Boolean)
    .includes(want);
}

/**
 * Classify an endpoint probe. The shell needs an OpenAI-compatible /v1, and
 * three different answers all look "up":
 *   - HTML  : a placeholder/marketing host. Renders as "(no response)".
 *   - 200   : suspicious for an UNAUTHENTICATED chat POST -- a real route
 *             refuses. A 200 here means something else is answering.
 *   - 401/400/403/422 : the route exists and is enforcing. THIS is healthy.
 */
export function classifyEndpoint(status: number, contentType: string): 'ok' | 'html' | 'wrong' {
  if ((contentType || '').toLowerCase().includes('text/html')) return 'html';
  if ([400, 401, 403, 422, 429, 503].includes(status)) return 'ok';
  if (status === 200) return 'wrong';
  return 'wrong';
}

/** Write a file and CONFIRM by reading it back. Returns false on a silent
 *  no-op, which is what Controlled Folder Access produces. */
export function writeVerified(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, 'utf-8');
  } catch {
    return false;
  }
  try {
    return readFileSync(path, 'utf-8') === content;
  } catch {
    return false;
  }
}

/** Append a line and CONFIRM it landed. Same reasoning as writeVerified. */
export function appendVerified(path: string, marker: string, block: string): boolean {
  let cur = '';
  try { cur = existsSync(path) ? readFileSync(path, 'utf-8') : ''; } catch { return false; }
  if (cur.includes(marker)) return true;                 // already installed
  return writeVerified(path, cur + block);
}


const NL = String.fromCharCode(10);

function pwsh(script: string): string {
  try {
    return execFileSync('pwsh', ['-NoProfile', '-Command', script],
                        { encoding: 'utf-8', timeout: 60000 }).trim();
  } catch {
    return '';
  }
}

/** Where this build lives, so setup can put a launcher next to it. */
function selfEntry(): string {
  try {
    return join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist', 'main.js');
  } catch {
    return '';
  }
}

/** STEP 1 - the command must resolve in a NEW terminal, not just in this one. */
function stepPath(): StepResult {
  const name = 'command on PATH';
  const machine = pwsh("[Environment]::GetEnvironmentVariable('PATH','Machine')");
  const user = pwsh("[Environment]::GetEnvironmentVariable('PATH','User')");
  if (!machine && !user) {
    return { name, state: 'failed', detail: 'could not read the persisted PATH' };
  }
  const npmBin = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm');
  if (onPersistedPath(npmBin, machine, user)) {
    return { name, state: 'ok', detail: npmBin + ' is on the persisted PATH' };
  }
  // Add it, then RE-READ. A SetEnvironmentVariable that returns is not proof.
  pwsh("[Environment]::SetEnvironmentVariable('PATH', " +
       "[Environment]::GetEnvironmentVariable('PATH','User') + ';" + npmBin + "', 'User')");
  const after = pwsh("[Environment]::GetEnvironmentVariable('PATH','User')");
  return onPersistedPath(npmBin, machine, after)
    ? { name, state: 'fixed', detail: 'added ' + npmBin + ' to the user PATH (new terminals only)' }
    : { name, state: 'failed', detail: 'could not add ' + npmBin + ' to the user PATH' };
}

/** STEP 2 - the shell integration, wherever it can actually be written. */
async function stepIntegration(initScript: string): Promise<StepResult> {
  const name = 'shell integration';
  const dir = join(homedir(), '.aither');
  const hook = join(dir, 'awsh-omnibox.ps1');
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { /* */ }
  if (!writeVerified(hook, initScript)) {
    return { name, state: 'failed', detail: 'could not write ' + hook };
  }

  // Preferred: the PowerShell profile, because it loads for EVERY pwsh however
  // it starts -- including one you launch from inside another shell.
  const profile = pwsh('$PROFILE.CurrentUserAllHosts');
  const marker = '# >>> awsh omnibox >>>';
  const block = NL + marker + NL +
    '$__awshOmni = Join-Path $HOME ".aither/awsh-omnibox.ps1"' + NL +
    'if (Test-Path $__awshOmni) { . $__awshOmni }' + NL +
    '# <<< awsh omnibox <<<' + NL;
  if (profile && appendVerified(profile, marker, block)) {
    return { name, state: 'ok', detail: 'installed in ' + profile + ' (every pwsh)' };
  }

  // Fallback: the terminal profile's command line. Only the outer tab gets it,
  // which is a real limitation and is REPORTED rather than glossed.
  const lad = process.env.LOCALAPPDATA || '';
  if (lad) {
    const { installIntoWindowsTerminal } = await import('./terminal-install.js');
    const r = installIntoWindowsTerminal(lad);
    if (r.ok) {
      return { name, state: 'fixed',
        detail: 'the PowerShell profile is NOT writable (Controlled Folder Access ' +
                'reports success and changes nothing), so this went into Windows ' +
                'Terminal instead: ' + r.message + '. Note a pwsh you start from ' +
                'inside a tab will NOT have it.' };
    }
    return { name, state: 'failed', detail: 'profile unwritable and ' + r.message };
  }
  return { name, state: 'failed', detail: 'no writable install location' };
}

/** STEP 3 - the endpoint must be an inference route, not a web page. */
async function stepEndpoint(candidates: string[]): Promise<StepResult & { url?: string }> {
  const name = 'inference endpoint';
  for (const base of candidates) {
    const url = base.replace(/\/+$/, '') + '/v1/chat/completions';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'probe', messages: [] }),
      });
      const verdict = classifyEndpoint(res.status, res.headers.get('content-type') || '');
      if (verdict === 'ok') {
        return { name, state: 'ok', detail: base + ' serves /v1 (refused unauthenticated, as a real route does)', url: base };
      }
      if (verdict === 'html') continue;      // a placeholder host
    } catch {
      continue;
    }
  }
  return { name, state: 'failed',
    detail: 'no candidate served an OpenAI-compatible /v1 - tried ' + candidates.join(', ') };
}

/** STEP 4 - packs must be visible, or `awsh <name>` silently does nothing. */
function stepPacks(count: number): StepResult {
  const name = 'agent packs';
  return count > 0
    ? { name, state: 'ok', detail: count + ' pack(s) discoverable' }
    : { name, state: 'failed', detail: 'no packs found - `awsh <name>` cannot launch anything' };
}

export interface SetupOptions {
  initScript: string;
  endpointCandidates: string[];
  packCount: number;
}

export async function runSetup(opts: SetupOptions): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  steps.push(stepPath());
  steps.push(await stepIntegration(opts.initScript));
  steps.push(await stepEndpoint(opts.endpointCandidates));
  steps.push(stepPacks(opts.packCount));
  return steps;
}
