/**
 * situation.ts — what the agent should simply KNOW about where it was asked from.
 *
 * WHY THIS EXISTS. Asked "what time is it" at the omnibox, the agent took 19.6 s
 * and answered with a sample output reading "Tuesday, June 4, 2025" — a date it
 * invented, because nothing in the request carried a clock. The model had two
 * bad options: guess, or spend a tool round-trip on `time_now` for a fact the
 * shell already had. Both are wrong for a shell. A terminal knows the time, the
 * directory, the user, the host and the shell dialect for free; a line typed
 * into it should arrive at the agent with that state attached, the way a
 * prompt string carries it for a human.
 *
 * So every turn the shell sends carries this block as a SYSTEM addition. The
 * agent answers time/date/where-am-I questions from context — no tool, no
 * guess — and every other answer is grounded in the real cwd / shell / OS
 * instead of the internet's modal assumptions (bash, Linux, sometime in 2025).
 *
 * DESIGN RULES (each one cost something to learn):
 *  - CHEAP. No subprocess, ever. `git branch` via exec costs ~60 ms on a warm
 *    box and >1 s on a cold NTFS tree; the branch is a one-line file read of
 *    `.git/HEAD` walking up from cwd, capped at 12 levels, and it is the ONLY
 *    filesystem access here. Everything else is process/OS state already in
 *    memory. A context block that makes every turn slower is a tax on the
 *    feature it decorates.
 *  - SMALL. ~10 lines, ~400 chars. It rides on every turn, so it must not
 *    crowd the model's context or bust a prompt cache: the shell appends it
 *    AFTER the stable system prompt, never before (a timestamp at the top of
 *    the system prompt invalidates the cached prefix on every single turn).
 *  - HONEST. A field it cannot determine is OMITTED, not guessed. A wrong
 *    shell name makes a wrong correction sound authoritative (the `ls -l`
 *    lesson in detectShell); a wrong timezone makes a wrong time sound exact.
 *  - THE USER'S CLOCK. This is the time on the machine the human typed on.
 *    The agent host may be elsewhere (a remote daemon, a fleet container);
 *    it attaches its own block, labelled differently. Two clocks, two labels,
 *    so the model never confuses "where I run" with "where you are".
 *
 * Kill switch: AWSH_SITUATION=0 (mirrors AWSH_OMNIBOX=0). Tested in
 * test/situation.test.ts; selfTest() here pins the properties a refactor
 * could drop silently.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname, platform, release, userInfo } from 'node:os';

/** Everything the block is built from, so tests can pin it without a clock. */
export interface SituationInputs {
  now: Date;
  cwd: string;
  shellName: string;
  env: NodeJS.ProcessEnv;
  platform: string;
  release: string;
  hostname: string;
  username: string;
  gitBranch?: string;
}

/** Header line the model (and tests) recognise the block by. */
export const SITUATION_HEADER = '[USER\'S SHELL — live state at the moment this line was sent]';

/** Read the git branch with ONE file read per level and no subprocess. */
export function readGitBranch(startDir: string, maxLevels = 12): string | undefined {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    const head = join(dir, '.git', 'HEAD');
    try {
      if (existsSync(head)) {
        const txt = readFileSync(head, 'utf8').trim();
        const m = /^ref:\s*refs\/heads\/(.+)$/.exec(txt);
        return m ? m[1] : (txt ? `detached@${txt.slice(0, 10)}` : undefined);
      }
      // A worktree has a `.git` FILE ("gitdir: ..."); treat it as "in a repo"
      // but do not chase the pointer — that is a second read we cannot bound.
      const gitFile = join(dir, '.git');
      if (existsSync(gitFile)) {
        const txt = readFileSync(gitFile, 'utf8');
        if (txt.startsWith('gitdir:')) return 'worktree';
      }
    } catch { /* unreadable → not a repo we can describe */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Human-readable local time: "Sunday 2026-08-23 06:11:05 (UTC-07:00, America/Los_Angeles)". */
export function formatLocalTime(now: Date, tz?: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const weekday = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][now.getDay()];
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const offMin = -now.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const off = `UTC${sign}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
  return `${weekday} ${date} ${time} (${off}${tz ? `, ${tz}` : ''})`;
}

function detectTimeZone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; }
  catch { return undefined; }
}

/** Collect the inputs from the live process. Cheap by construction — see header. */
export function collectSituation(shellName: string, env: NodeJS.ProcessEnv = process.env): SituationInputs {
  let username = '';
  try { username = userInfo().username; } catch { /* sandboxed → omit */ }
  const cwd = process.cwd();
  return {
    now: new Date(),
    cwd,
    shellName,
    env,
    platform: platform(),
    release: release(),
    hostname: (() => { try { return hostname(); } catch { return ''; } })(),
    username,
    gitBranch: readGitBranch(cwd),
  };
}

/** Render the block. Pure: same inputs → same text. */
export function renderSituation(s: SituationInputs): string {
  const tz = detectTimeZone();
  const osName = s.platform === 'win32' ? `Windows ${s.release}`
               : s.platform === 'darwin' ? `macOS (Darwin ${s.release})`
               : `${s.platform} ${s.release}`;
  const lines: string[] = [SITUATION_HEADER];
  lines.push(`local time: ${formatLocalTime(s.now, tz)}`);
  lines.push(`utc: ${s.now.toISOString()}`);
  if (s.shellName && !/^unknown/i.test(s.shellName)) lines.push(`shell: ${s.shellName}`);
  lines.push(`os: ${osName}`);
  if (s.hostname) lines.push(`host: ${s.hostname}`);
  if (s.username) lines.push(`user: ${s.username}`);
  lines.push(`cwd: ${s.cwd}`);
  if (s.gitBranch) lines.push(`git branch: ${s.gitBranch}`);
  const term = s.env.TERM_PROGRAM || (s.env.WT_SESSION ? 'Windows Terminal' : s.env.TERM);
  if (term) lines.push(`terminal: ${term}`);
  lines.push(
    'Use this block as ground truth for time, date, weekday, timezone, cwd, user, host ' +
    'and shell. Answer such questions directly from it — do NOT call a tool and do NOT ' +
    'guess or invent a date. When you show an example of a command\'s output, derive it ' +
    'from these values.',
  );
  return lines.join('\n');
}

/**
 * Which shell dialect is the human typing in? Env-first, same ladder as
 * main.ts's detectShell() (which cannot be imported here without pulling
 * main()'s top-level side effects into the client). Unknown is SAID as
 * undefined and then OMITTED from the block — never guessed.
 */
export function sniffShellName(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const forced = (env.AITHER_OMNIBOX_SHELL || '').trim().toLowerCase();
  if (forced) {
    if (forced === 'powershell') return 'Windows PowerShell 5.1';
    if (forced.startsWith('pwsh') || forced.startsWith('power')) return 'PowerShell 7 (pwsh)';
    if (forced === 'awsh') return 'awsh (the AitherOS shell)';
    return forced;
  }
  if (env.POWERSHELL_DISTRIBUTION_CHANNEL) return 'PowerShell 7 (pwsh)';
  if (env.PSModulePath) return 'Windows PowerShell';
  const sh = (env.SHELL || '').split('/').pop() || '';
  return sh || undefined;
}

/**
 * Answer a pure state question FROM THE SHELL, deterministically, before the
 * agent is even asked.
 *
 * WHY. With the situation block attached, the model answered "what time is it"
 * correctly on one run and, minutes later, printed only `Get-Date -DisplayHint
 * DateTime` for "WHAT TIME IS IT" — and echoed the line back on the owner's
 * run. A fact the shell already holds must not depend on a small model's
 * mood. So the fact is printed by the shell in 0 ms, and the agent is asked
 * only for the part it is good at: the command that prints it.
 *
 * Deliberately NARROW: only lines that are unambiguously about the clock, the
 * directory, the user or the host. Anything else goes to the agent untouched;
 * a false positive here would hide a real question behind a timestamp.
 */
export interface StateAnswer {
  /** The value itself, from the shell's own registers. */
  value: string;
  /** The idiomatic built-in that prints it in THIS shell — also deterministic:
   *  measured 2026-08-23, the 4B orchestrator bolted a junk `-Format` string
   *  onto `Get-Date` on 5 of 6 runs however it was asked. */
  command: string;
}

function isPwsh(shellName: string): boolean {
  return /powershell|pwsh|awsh/i.test(shellName);
}

export function answerFromSituation(line: string, s: SituationInputs): StateAnswer | undefined {
  const q = line.trim().toLowerCase().replace(/[?!.]+$/g, '').replace(/\s+/g, ' ');
  const tz = detectTimeZone();
  const ps = isPwsh(s.shellName);
  if (/^(what('?s| is)? (the )?(current |local )?(time|date|day|date and time|time and date)( (is it|now|today|is it now|right now))?|what day( is it| is today)?|what time|time now|date now|current time|today'?s date|(what )?year( is it)?|what month( is it)?)$/.test(q)) {
    return { value: formatLocalTime(s.now, tz), command: ps ? 'Get-Date' : 'date' };
  }
  if (/^(where am i|what (dir|directory|folder) am i in|current (dir|directory|folder)|pwd|cwd)$/.test(q)) {
    return { value: s.cwd, command: ps ? 'Get-Location' : 'pwd' };
  }
  if (/^(who am i|whoami|what('?s| is) my (user|username|user name))$/.test(q)) {
    return s.username ? { value: s.username, command: ps ? '$env:USERNAME' : 'whoami' } : undefined;
  }
  if (/^(what('?s| is) (the |my )?(host|hostname|computer|machine)( name)?|hostname|what (computer|machine) is this)$/.test(q)) {
    return s.hostname ? { value: s.hostname, command: 'hostname' } : undefined;
  }
  return undefined;
}

/**
 * Strip the opener a small model keeps producing at the omnibox no matter what
 * the prompt says — "This was a question, not a command." / "The line "x" is
 * not a recognized command." — measured on 1 in 2 runs of the 4B orchestrator
 * AFTER the prompt told it never to. The user typed the line; they know it is
 * not a command. Only a LEADING sentence of that shape is removed, and only
 * when something remains after it; a whole answer is never deleted.
 */
export function stripOmniboxOpener(answer: string): string {
  let text = (answer || '').trim();
  for (let i = 0; i < 2; i++) {
    const m = /^(?:(?:(?:this|that)(?:\s+(?:line|command|input|text|phrase))?|the (?:line|command|input|text|phrase)(?:\s+["'`][^"'`]*["'`])?|["'`][^"'`]*["'`])\s+(?:was|is|isn't|is not|does not|doesn't)\b[^.!?\n]*(?:command|cmdlet|question|executable|recogni[sz]ed|typo|misspell)[^.!?;\n]*[.!?;]\s*(?:it is a question[.!?;]?\s*)?)/i
      .exec(text);
    if (!m) break;
    const rest = text.slice(m[0].length).trim();
    if (!rest) break;
    text = rest;
  }
  return text;
}

/** Kill switch, mirroring AWSH_OMNIBOX. */
export function situationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AWSH_SITUATION !== '0';
}

/** One call for the hot path: the block, or undefined when disabled. */
export function buildSituation(shellName?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!situationEnabled(env)) return undefined;
  try { return renderSituation(collectSituation(shellName ?? sniffShellName(env) ?? '', env)); }
  catch { return undefined; }   // a context block must never take the turn down with it
}

/** `--self-test`: the properties a refactor would drop silently. */
export function selfTest(): string[] {
  const failures: string[] = [];
  const fixed = new Date(2026, 7, 23, 6, 11, 5);   // Sunday 2026-08-23 06:11:05 local
  const base: SituationInputs = {
    now: fixed, cwd: 'C:\\Users\\wzns', shellName: 'PowerShell 7 (pwsh)', env: {},
    platform: 'win32', release: '10.0.26200', hostname: 'BOX', username: 'wzns',
    gitBranch: 'feat/x',
  };
  const out = renderSituation(base);
  if (!out.startsWith(SITUATION_HEADER)) failures.push('block lost its header');
  if (!out.includes('Sunday 2026-08-23 06:11:05')) failures.push('local time not rendered from the supplied clock');
  if (!out.includes(fixed.toISOString())) failures.push('utc line missing');
  if (!out.includes('cwd: C:\\Users\\wzns')) failures.push('cwd missing');
  if (!out.includes('git branch: feat/x')) failures.push('git branch missing');
  if (!/do NOT call a tool/.test(out)) failures.push('lost the no-tool instruction — the whole point');
  // Honest omission: unknown shell and empty host/user must NOT be printed as facts.
  const sparse = renderSituation({ ...base, shellName: 'unknown (do not assume bash)', hostname: '', username: '', gitBranch: undefined });
  if (/^shell:/m.test(sparse)) failures.push('an unknown shell was stated as a fact');
  if (/^host:/m.test(sparse) || /^user:/m.test(sparse)) failures.push('empty host/user rendered');
  if (/git branch/.test(sparse)) failures.push('absent git branch rendered');
  // Size budget: this rides on EVERY turn.
  if (out.length > 900) failures.push(`block is ${out.length} chars; budget is 900`);
  // Kill switch.
  if (situationEnabled({ AWSH_SITUATION: '0' })) failures.push('AWSH_SITUATION=0 did not disable');
  if (!situationEnabled({})) failures.push('default must be enabled');
  if (buildSituation('pwsh', { AWSH_SITUATION: '0' }) !== undefined) failures.push('buildSituation ignored the kill switch');
  return failures;
}
