/**
 * `awsh agent [name]` -- a persistent, tool-using agent session in the terminal.
 *
 * The default awsh prompt talks to a CHAT backend (Genesis or an adk daemon): no
 * read/edit/bash, no resume, no named agent. That is the gap the owner named on
 * 2026-11-09 ("not the Claude Code replacement I want"). This REPL instead drives a
 * Claude Code session OWNED BY THE HARNESS DAEMON (:8362) as `claude --agent <name>`:
 * the same tools, hooks, skills, MCP servers and CLAUDE.md the owner has in Claude
 * Code, streamed turn by turn.
 *
 * Because the daemon owns the process, a session outlives this terminal: the cockpit,
 * the desk and `aither harness tell` can steer it, and `awsh agent <name>` in the same
 * directory reattaches to it (or wakes it from its own log when it died, or resumes
 * the Claude conversation by id when the daemon no longer knows it).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fairyTag } from './agent-fairy.js';
import { HookTally, formatHookFailure, hookOutcome } from './hook-events.js';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

export const DEFAULT_AGENT = 'aither';
export const DEFAULT_HARNESS = 'claude';
export const DEFAULT_PERMISSION_MODE = 'acceptEdits';
const DEAD = new Set(['exited', 'failed']);

export interface AgentArgs {
  agent: string;
  harness: string;
  fresh: boolean;
  resume: string;
  permissionMode: string;
  cwd: string;
  model: string;
  /** One-shot: send this, print the answer, exit. */
  prompt: string;
}

/** Pure: `[name] [--harness claude|antigravity|codex|gemini|adk] [--new] [--resume id] [--permission-mode m] [--cwd d] [--model m] [-p text]`. */
export function parseAgentArgs(argv: string[], cwd = process.cwd()): AgentArgs {
  const out: AgentArgs = {
    agent: '', harness: '', fresh: false, resume: '', permissionMode: '', cwd, model: '', prompt: '',
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (i + 1 < argv.length ? argv[++i] : '');
    if (a === '--new') out.fresh = true;
    else if (a === '--harness' || a === '-H') out.harness = val().trim().toLowerCase();
    else if (a === '--resume' || a === '-r') out.resume = val();
    else if (a === '--permission-mode') out.permissionMode = val();
    else if (a === '--cwd') { const v = val(); out.cwd = v && isAbsolute(v) ? v : resolvePath(cwd, v || '.'); }
    else if (a === '--model') out.model = val();
    else if (a === '-p' || a === '--print') out.prompt = val();
    else rest.push(a);
  }
  out.agent = (rest.shift() || DEFAULT_AGENT).toLowerCase().replace(/^@/, '');
  if (!out.prompt && rest.length) out.prompt = rest.join(' ');
  out.harness = out.harness || (process.env.AWSH_AGENT_HARNESS || '').trim().toLowerCase() || DEFAULT_HARNESS;
  out.permissionMode = out.permissionMode
    || (process.env.AWSH_AGENT_PERMISSION_MODE || '').trim() || DEFAULT_PERMISSION_MODE;
  return out;
}

/**
 * Pure: the cwd the harness daemon can open. Inside WSL the daemon is the WINDOWS
 * host's (reached over the fleet bridge), so `/mnt/c/x` and `/var/mnt/c/x` become
 * `C:\x`; a Linux-only path such as `/root` has no Windows twin and becomes ''
 * (the daemon's own default). Measured 2026-11-09: `awsh agent` from /root in awnix
 * failed "cwd does not exist: \var\roothome".
 */
export function hostCwd(cwd: string, crossesToWindows: boolean): string {
  if (!crossesToWindows) return cwd;
  const m = cwd.replace(/\\/g, '/').match(/^(?:\/var)?\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (!m) return '';
  const rest = (m[2] || '').replace(/\/+$/, '').replace(/\//g, '\\');
  return `${m[1].toUpperCase()}:\\${rest}`;
}

/** Pure: the POST /sessions body for a named-agent harness session. */
export function agentSessionBody(a: AgentArgs, claudeSessionId = ''): Record<string, unknown> {
  const harness = a.harness || DEFAULT_HARNESS;
  const body: Record<string, unknown> = {
    harness,
    cwd: a.cwd,
    title: `awsh · ${a.agent}`,
    permission_mode: a.permissionMode,
  };
  if (harness === 'claude') {
    body.extra_args = ['--agent', a.agent];
  } else {
    body.agent = a.agent;
  }
  if (a.model) body.model = a.model;
  if (claudeSessionId) body.resume_session_id = claudeSessionId;
  return body;
}

// ── the per-(agent, cwd) session memory ───────────────────────────────────

export interface SessionRecord {
  id: string;
  agent: string;
  cwd: string;
  harness_session_id?: string;
  updated_at: number;
}

export const STORE_PATH = join(homedir(), '.aither', 'awsh-agent-sessions.json');

export function storeKey(agent: string, cwd: string): string {
  return `${agent}::${cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`;
}

export function loadStore(path = STORE_PATH): Record<string, SessionRecord> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function saveRecord(rec: SessionRecord, path = STORE_PATH): void {
  try {
    const all = loadStore(path);
    all[storeKey(rec.agent, rec.cwd)] = rec;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all, null, 2));
  } catch { /* memory is a convenience; the daemon still owns the session */ }
}

// ── rendering ──────────────────────────────────────────────────────────────

const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** Pure: the terminal text for one harness event ('' = print nothing). */
export function renderEvent(ev: any): string {
  switch (ev?.kind) {
    case 'text.delta': return String(ev.text ?? '');
    case 'thinking.delta': return DIM(String(ev.text ?? ''));
    case 'tool.call': return `\n${CYAN(`-> ${ev.tool || 'tool'}`)}\n`;
    case 'tool.result': return `${CYAN(`<- ${ev.tool || 'result'}${ev.data?.is_error ? ' (error)' : ''}`)}\n`;
    case 'error': return `\n${RED(`! ${ev.text ?? 'error'}`)}\n`;
    case 'turn.completed': return '\n';
    case 'session.exited': return `\n${DIM(`-- session exited (${ev.data?.exit_code ?? '?'}) --`)}\n`;
    default: return '';
  }
}

export function endsTurn(ev: any): boolean {
  return ev?.kind === 'turn.completed' || ev?.kind === 'session.exited';
}

// ── the daemon conversation ───────────────────────────────────────────────

export type Api = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface ReplDeps {
  api: Api;
  write: (s: string) => void;
  readLine: (prompt: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  storePath?: string;
  /** Local `/status`, `/cards`, `/board` -- injected so this module stays daemon-only. */
  local?: Record<string, (args: string) => Promise<void>>;
  /** True when this shell is in WSL and the daemon is the Windows host's (hostCwd). */
  crossesToWindows?: boolean;
}

/** A connection failure (the daemon is not there) vs a refusal (it answered no). */
export function isUnreachable(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|no harness token/i.test(message);
}

export interface OpenedSession {
  id: string;
  cursor: number;
  how: 'live' | 'woken' | 'claude-resume' | 'new';
  harnessSessionId: string;
}

async function getInfo(api: Api, id: string): Promise<any | null> {
  try { return await api<any>(`/sessions/${encodeURIComponent(id)}`); } catch { return null; }
}

/**
 * Reattach, wake, resume or create -- in that order -- and never silently: the
 * caller prints `how`. `target` is a daemon session id or a Claude session id.
 */
export async function openAgentSession(a: AgentArgs, deps: Pick<ReplDeps, 'api' | 'storePath'>): Promise<OpenedSession> {
  const { api } = deps;
  const remembered = loadStore(deps.storePath)[storeKey(a.agent, a.cwd)];
  const target = a.resume || (a.fresh ? '' : remembered?.id || '');
  let claudeId = a.resume ? '' : remembered?.harness_session_id || '';
  if (target) {
    const info = await getInfo(api, target);
    if (info && !DEAD.has(String(info.state))) {
      return { id: info.id, cursor: Number(info.last_seq) || 0, how: 'live', harnessSessionId: info.harness_session_id || '' };
    }
    if (info) {
      try {
        const woke = await api<any>(`/sessions/${encodeURIComponent(target)}/wake`, { method: 'POST', body: '{}' });
        const s = woke?.session || (await getInfo(api, target)) || {};
        return { id: s.id || target, cursor: Number(s.last_seq) || 0, how: 'woken', harnessSessionId: s.harness_session_id || '' };
      } catch { /* fall through to a resumed or fresh session */ }
      claudeId = info.harness_session_id || claudeId;
    } else if (a.resume) {
      claudeId = a.resume;   // not a daemon id: treat it as a Claude session id
    }
  }
  const created = await api<any>('/sessions', {
    method: 'POST',
    body: JSON.stringify(agentSessionBody(a, claudeId)),
  });
  return {
    id: created.id,
    cursor: Number(created.last_seq) || 0,
    how: claudeId ? 'claude-resume' : 'new',
    harnessSessionId: created.harness_session_id || claudeId,
  };
}

/** Submit one turn and stream it to `write` until it ends. Returns the new cursor. */
export async function runTurn(
  id: string, text: string, cursor: number,
  deps: Pick<ReplDeps, 'api' | 'write' | 'sleep'> & { hooks?: HookTally },
  isInterrupted: () => boolean = () => false,
): Promise<{ cursor: number; harnessSessionId: string; ended: 'turn' | 'exited' | 'interrupted' }> {
  const { api, write } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sid = encodeURIComponent(id);
  const submit = () => api(`/sessions/${sid}/submit`, { method: 'POST', body: JSON.stringify({ text, submit: true }) });
  try {
    await submit();
  } catch (err: any) {
    // A just-spawned session is `starting` and refuses input (409). Wait for it once.
    if (!/cannot accept input|starting/i.test(String(err?.message))) throw err;
    await api(`/sessions/${sid}/wait?until=ready,idle&timeout=60`).catch(() => null);
    await submit();
  }
  let harnessSessionId = '';
  let interruptSent = false;
  // This turn's hooks fold into one dim line; the session-wide tally feeds /hooks.
  let turnHooks = new HookTally();
  const flushHooks = () => {
    const line = turnHooks.summary();
    if (line) write(`${DIM(line)}\n`);
    turnHooks = new HookTally();
  };
  for (;;) {
    if (isInterrupted() && !interruptSent) {
      interruptSent = true;
      await api(`/sessions/${sid}/interrupt`, { method: 'POST', body: '{}' }).catch(() => null);
      write(`\n${DIM('-- interrupt sent --')}\n`);
    }
    const res = await api<{ events: any[]; state?: string }>(`/sessions/${sid}/events?after=${cursor}`);
    for (const ev of res?.events || []) {
      if (typeof ev.seq === 'number') cursor = ev.seq;
      const hs = ev?.data?.harness_session_id;
      if (hs) harnessSessionId = String(hs);
      const hook = hookOutcome(ev);
      if (hook) {
        turnHooks.add(hook);
        deps.hooks?.add(hook);
        if (!hook.ok) write(`\n${RED(formatHookFailure(hook))}\n`);
        continue;
      }
      if (ev?.kind === 'session.ready') flushHooks();
      const out = renderEvent(ev);
      if (out) write(out);
      if (endsTurn(ev)) {
        flushHooks();
        return { cursor, harnessSessionId, ended: ev.kind === 'session.exited' ? 'exited' : (interruptSent ? 'interrupted' : 'turn') };
      }
    }
    if (res?.state && DEAD.has(res.state)) return { cursor, harnessSessionId, ended: 'exited' };
    await sleep(250);
  }
}

export const AGENT_REPL_HELP = [
  '  /exit         leave (the session keeps running in the daemon; rerun to reattach)',
  '  /new          start a fresh session with the same agent',
  '  /harness [h]  show current harness or switch (claude, antigravity, codex, gemini, adk)',
  '  /avatar [n]   render this agent\'s terminal avatar inline',
  '  /id           this session\'s daemon id and harness session id',
  '  /hooks        the hooks this session ran, and the last failures',
  '  /status       fleet, Atlas board, waiting cards',
  '  /cards        waiting decision cards (answer: /cards answer <n> <option>)',
  '  /board        the Atlas board',
  '  Ctrl+C        interrupt the running turn',
].join('\n');

/** The REPL. Returns a process exit code; never throws for daemon errors. */
export async function runAgentRepl(argv: string[], deps: ReplDeps): Promise<number> {
  let a = parseAgentArgs(argv);
  const { write } = deps;
  const localCwd = a.cwd;
  a = { ...a, cwd: hostCwd(a.cwd, !!deps.crossesToWindows) };
  if (deps.crossesToWindows && !a.cwd) {
    write(DIM(`  ${localCwd} has no Windows path; the session runs in the host daemon's default directory\n`));
  }
  let session: OpenedSession;
  try {
    session = await openAgentSession(a, deps);
  } catch (err: any) {
    const msg = String(err?.message || err);
    write(`${RED(`agent: ${msg}`)}\n`);
    if (isUnreachable(msg)) {
      write(DIM('  the harness daemon owns agent sessions: start it with `adk harness serve`\n'));
    }
    return 1;
  }
  const remember = () => saveRecord({
    id: session.id, agent: a.agent, cwd: a.cwd,
    harness_session_id: session.harnessSessionId || undefined, updated_at: Math.floor(Date.now() / 1000),
  }, deps.storePath);
  remember();
  const howText = { live: 'reattached', woken: 'woken from its log', 'claude-resume': 'resumed the session', new: 'new session' }[session.how];
  write(`  ${fairyTag(a.agent)} ${DIM(`· ${a.harness} · ${howText} · ${session.id} · ${a.permissionMode} · /help`)}\n`);

  const hooks = new HookTally();
  let interrupted = false;
  const onSigint = () => { interrupted = true; };
  const turn = async (text: string): Promise<boolean> => {
    interrupted = false;
    process.on('SIGINT', onSigint);
    try {
      const r = await runTurn(session.id, text, session.cursor, { ...deps, hooks }, () => interrupted);
      session.cursor = r.cursor;
      if (r.harnessSessionId) session.harnessSessionId = r.harnessSessionId;
      remember();
      return r.ended !== 'exited';
    } catch (err: any) {
      write(`${RED(`! ${err?.message || err}`)}\n`);
      return true;
    } finally {
      process.off('SIGINT', onSigint);
    }
  };

  if (a.prompt) {
    const alive = await turn(a.prompt);
    return alive ? 0 : 1;
  }

  for (;;) {
    const line = await deps.readLine(`${a.agent}> `);
    if (line === null) return 0;
    const text = line.trim();
    if (!text) continue;
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const verb = cmd.toLowerCase();
      if (verb === 'exit' || verb === 'quit') return 0;
      if (verb === 'help') { write(`${AGENT_REPL_HELP}\n`); continue; }
      if (verb === 'hooks') {
        write(`  ${hooks.summary() || 'no hooks have run in this session yet'}\n`);
        for (const f of hooks.failures.slice(-5)) write(`  ${formatHookFailure(f)}\n`);
        continue;
      }
      if (verb === 'id') { write(`  daemon ${session.id} · ${a.harness} ${session.harnessSessionId || '(not yet reported)'}\n`); continue; }
      if (verb === 'harness') {
        const nextH = (rest[0] || '').trim().toLowerCase();
        if (!nextH) { write(`  harness: ${a.harness}  (switch: /harness <antigravity|claude|codex|gemini|adk>)\n`); continue; }
        a = { ...a, harness: nextH, fresh: true, resume: '' };
        try {
          session = await openAgentSession(a, deps);
          remember();
          write(DIM(`  switched to ${a.harness} · session ${session.id}\n`));
        } catch (err: any) { write(`${RED(`! ${err?.message || err}`)}\n`); }
        continue;
      }
      if (verb === 'avatar') {
        const { runAvatarCommand } = await import('./avatar-command.js');
        await runAvatarCommand(rest.length ? rest : ['show', a.agent, '--cols', '22'], { write });
        continue;
      }
      if (verb === 'new') {
        a = { ...a, fresh: true, resume: '' };
        try {
          session = await openAgentSession(a, deps);
          remember();
          write(DIM(`  new session ${session.id}\n`));
        } catch (err: any) { write(`${RED(`! ${err?.message || err}`)}\n`); }
        continue;
      }
      const local = deps.local?.[verb];
      if (local) { await local(rest.join(' ')).catch((e) => write(`${RED(`! ${e?.message || e}`)}\n`)); continue; }
      // Anything else is the agent's own slash command (skills, /compact, ...): pass it through.
    }
    const alive = await turn(text);
    if (!alive) {
      write(DIM('  the session exited; next message wakes it from its log\n'));
      a = { ...a, fresh: false, resume: session.id };
      try { session = await openAgentSession(a, deps); remember(); } catch { return 1; }
    }
  }
}
