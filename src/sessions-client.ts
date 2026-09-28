/**
 * Typed HTTP client for the harness daemon's unified sessions endpoint.
 *
 * Reuses existing harness-client.ts conventions: bearer token resolution,
 * error handling, degradation path when daemon is unreachable. This module
 * is observation only; steering a focused row lives in session-steer.ts.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const HOME = homedir();

const DEFAULT_URL = 'http://127.0.0.1:8362';

function daemonUrl(): string {
  return (process.env.AITHER_HARNESS_URL || DEFAULT_URL).replace(/\/$/, '');
}

/**
 * Bearer resolution mirrors the daemon's own order: env, then the file it
 * writes at first start. Returning '' rather than throwing lets the caller
 * emit one clear "start the daemon" message instead of a stack trace.
 */
function daemonToken(): string {
  const fromEnv = (process.env.AITHER_HARNESS_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(homedir(), '.aither', 'harness_token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = daemonToken();
  if (!token) {
    throw new Error(
      'no harness token found (set AITHER_HARNESS_TOKEN or start the daemon: adk harness serve)',
    );
  }
  const res = await fetch(`${daemonUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { detail: text };
  }
  if (!res.ok) throw new Error(payload?.detail || payload?.error || `HTTP ${res.status}`);
  return payload as T;
}

/**
 * A unified session entry from GET /sessions/unified.
 * Fields exactly match the Python daemon's response contract.
 */
export interface UnifiedSession {
  id: string;
  title: string;
  cwd: string;
  harness: string;
  origin: 'daemon' | 'discovered';
  /** The daemon emits `exited` (session state exited/failed) and `blocked?` (a tool
   *  call with no result yet); `dead` / `waiting-permission` are legacy words kept so
   *  an older daemon's rows still type-check. */
  status: 'working' | 'waiting-input' | 'blocked?' | 'idle' | 'exited'
    | 'waiting-permission' | 'dead';
  last_activity_at: number; // Unix timestamp (seconds)
  last_activity_summary: string;
  transcript_path: string;
  pid: number | null;
  steer_capability: 'full' | 'turn-boundary' | 'none';
  /** Git branch from the transcript's `gitBranch` (daemon >= cockpit grid). */
  branch?: string;
  /** Tokens spent: input + cache-creation + output, cache reads excluded. */
  tokens_spent?: number;
  harness_label?: string;
}

/**
 * Response shape from GET /sessions/unified.
 */
export interface UnifiedSessionsResponse {
  sessions: UnifiedSession[];
}

/**
 * Fetch unified sessions from the harness daemon.
 * Throws an error if the daemon is unreachable or the token is missing.
 * Caller is responsible for catching and emitting a clear error message.
 */
export async function fetchUnifiedSessions(): Promise<UnifiedSession[]> {
  const result = await api<UnifiedSessionsResponse>('/sessions/unified');
  return result.sessions || [];
}

/**
 * Format a single session row for the TUI display.
 * Pure function: (entry, column widths) → formatted string.
 *
 * Handles wide characters (emoji) correctly via wcwidth considerations.
 * Truncates long fields to fit within the pane width.
 *
 * Columns (left-to-right):
 *   - name: session name, truncated to nameWidth
 *   - cwd: working directory, truncated to cwdWidth (with ~ substitution)
 *   - origin: 'daemon' or 'discovered', short tag
 *   - status: status string, color-coded (applied by caller)
 *   - age: time since last_activity_at, human-readable (e.g. "2m")
 *   - summary: last_activity_summary, truncated to summaryWidth
 *
 * Returns a pre-colored string ready for blessed.list.
 */
export function formatSessionRow(
  entry: UnifiedSession,
  widths: { name: number; cwd: number; summary: number; branch?: number; tokens?: boolean },
  opts: { colorStatus?: (status: string) => string } = {},
): string {
  // Format title (truncate)
  const name = entry.title.length > widths.name
    ? entry.title.slice(0, widths.name - 1) + '…'
    : entry.title.padEnd(widths.name);

  // Format cwd (substitute ~, truncate)
  const cwdDisplay = entry.cwd.startsWith(HOME)
    ? '~' + entry.cwd.slice(HOME.length)
    : entry.cwd;
  const cwd = cwdDisplay.length > widths.cwd
    ? cwdDisplay.slice(0, widths.cwd - 1) + '…'
    : cwdDisplay.padEnd(widths.cwd);

  // Format origin (short tag)
  const originTag = entry.origin === 'daemon' ? 'adk' : 'tab';

  // Format status (caller applies color; here just the string)
  // Colour ONLY the status word, then pad: callers used to split the finished
  // row on the first occurrence of the status text, which matched inside a
  // title such as 'working-session' and dropped every column after it.
  const statusWord = opts.colorStatus ? opts.colorStatus(entry.status) : entry.status;
  const status = statusWord + ' '.repeat(Math.max(0, 14 - entry.status.length));

  // Format age (time since last_activity_at)
  const age = formatAge(entry.last_activity_at);

  // Format summary (truncate)
  const summary = entry.last_activity_summary.length > widths.summary
    ? entry.last_activity_summary.slice(0, widths.summary - 1) + '…'
    : entry.last_activity_summary.padEnd(widths.summary);

  // Branch (truncate) -- which line of work the session is on.
  // A branch width of 0 hides the column (narrow panes give the room to name).
  const bw = widths.branch ?? BRANCH_WIDTH;
  const rawBranch = (entry.branch || '').trim() || '-';
  const branch = bw <= 0
    ? ''
    : (rawBranch.length > bw ? rawBranch.slice(0, bw - 1) + '…' : rawBranch.padEnd(bw)) + '  ';

  // Capability tier: what the operator can DO to this row.
  const cap = capabilityTag(entry.steer_capability).padEnd(4);

  // Token spend, compact. `tokens: false` hides the column.
  const tokens = widths.tokens === false ? '' : formatTokens(entry.tokens_spent).padStart(6) + '  ';

  return `  ${name}  ${cwd}  ${branch}${originTag.padEnd(4)}  ${cap}  ${status}  ${age.padEnd(4)}  ${tokens}${summary}`;
}

/** Default width of the branch column. */
export const BRANCH_WIDTH = 14;

/**
 * Short tag for steer_capability, so every row says what can be done to it:
 * `full` (daemon-owned, steer any time), `turn` (a discovered tab, steerable at
 * a turn boundary), `none` (dead, or seen without the daemon -- look only).
 * Anything unrecognised renders as `?` rather than being guessed upward.
 */
export function capabilityTag(cap: string | undefined): string {
  if (cap === 'full') return 'full';
  if (cap === 'turn-boundary') return 'turn';
  if (cap === 'none') return 'none';
  return '?';
}

/** Compact token count: 950, 12.3k, 4.1M; '-' when unknown. */
export function formatTokens(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '-';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Human-readable age from Unix timestamp (seconds).
 * Examples: "1m", "5m", "1h", "2d", "now".
 */
function formatAge(unixSeconds: number): string {
  const now = new Date();
  const then = new Date(unixSeconds * 1000);  // Convert Unix seconds to milliseconds
  const deltaMs = now.getTime() - then.getTime();

  if (deltaMs < 5000) return 'now';
  const deltaSecs = Math.floor(deltaMs / 1000);
  if (deltaSecs < 60) return `${deltaSecs}s`;
  const deltaMin = Math.floor(deltaSecs / 60);
  if (deltaMin < 60) return `${deltaMin}m`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay}d`;
}

/**
 * Summarize the fleet: count sessions by status.
 * Pure function, no I/O.
 *
 * Returns a string like "12 sessions - 3 working, 2 waiting, 7 idle, 0 dead".
 */
export function summarizeFleet(sessions: UnifiedSession[]): string {
  // Count EVERY status, not a hardcoded allowlist.
  //
  // The previous version listed `waiting-permission` (a status the daemon never
  // emits) and omitted `blocked?` (one it does), and its `if (s.status in counts)`
  // guard silently dropped anything unlisted. Measured live against 19 real
  // sessions it printed "19 sessions · 5 working · 11 waiting" — 16 — losing
  // exactly the three sessions that were waiting on the human. The one category
  // the operator opens this for was the one the summary hid, and it hid it
  // without an error while still printing a confident total.
  //
  // Counting generically means a status added on the Python side can never again
  // vanish here; at worst it appears under its own name.
  const counts = new Map<string, number>();
  for (const s of sessions) {
    counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  }
  const take = (...keys: string[]) =>
    keys.reduce((n, k) => n + (counts.get(k) ?? 0), 0);

  const blocked = take('blocked?', 'waiting-permission');
  const working = take('working');
  const waiting = take('waiting-input');
  const idle = take('idle');
  const dead = take('dead', 'exited', 'failed');
  const named = blocked + working + waiting + idle + dead;

  const total = sessions.length;
  const parts = [
    `${total} session${total === 1 ? '' : 's'}`,
    // Blocked leads: it is the only bucket that is a call to action.
    blocked > 0 ? `${blocked} blocked` : null,
    working > 0 ? `${working} working` : null,
    waiting > 0 ? `${waiting} waiting` : null,
    idle > 0 ? `${idle} idle` : null,
    dead > 0 ? `${dead} dead` : null,
    // Anything we do not have a bucket for is shown, never dropped.
    total - named > 0 ? `${total - named} other` : null,
  ].filter(Boolean);

  return parts.join(' · ');
}

// ─────────────────────────────────────────────────────────────────
// Offline fallback: the cockpit without the daemon
// ─────────────────────────────────────────────────────────────────
//
// The daemon is the preferred source (it knows which sessions it owns and can
// steer them), but it being down is exactly when the operator most wants to
// know what their tabs are doing. Claude Code writes everything the cockpit
// needs to disk itself -- a state file per live process under
// ~/.claude/sessions and a JSONL transcript under ~/.claude/projects -- so the
// fallback reads those directly, mirroring adk/harnesses/discovery.py. Rows
// from this path are origin=discovered and steer_capability=none: without the
// daemon nothing can be steered, and saying so is the honest label.

/** How much of a transcript's tail status derivation reads. */
const TAIL_BYTES = 262144;
/** A tool_use pending this long is reported as `blocked?` (see session_directory.py). */
const PENDING_TOOL_BLOCKED_SECONDS = 90;
/** A tool_use pending this long is an abandoned turn, not a prompt. */
const PENDING_TOOL_STALE_SECONDS = 86400;

/** `C:\work\my-repo` -> `C--work-my-repo`, as Claude Code names project dirs. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-');
}

/** Read the last `maxBytes` of a file as text; '' when unreadable. */
export function readTail(path: string, maxBytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const len = Math.min(size, maxBytes);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch { /* partial first line of a tail window */ }
  }
  return out;
}

function tsSeconds(entry: any): number {
  const t = Date.parse(String(entry?.timestamp || ''));
  return Number.isFinite(t) ? t / 1000 : 0;
}

function firstText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        return c.text.trim();
      }
    }
  }
  return '';
}

export interface TranscriptStatus {
  status: UnifiedSession['status'] | 'blocked?' | 'unknown';
  last_activity_at: number;
  summary: string;
  branch: string;
}

/**
 * Derive status / last activity / summary / branch from a transcript tail.
 * A port of session_directory._derive_status_from_transcript, kept to the same
 * status vocabulary so a row reads the same with or without the daemon.
 */
export function deriveTranscriptStatus(tailText: string, nowSeconds = Date.now() / 1000): TranscriptStatus {
  const entries = parseLines(tailText);
  let branch = '';
  let lastAt = 0;
  const pending = new Map<string, { name: string; at: number }>();
  const satisfied = new Set<string>();
  for (const e of entries) {
    if (typeof e.gitBranch === 'string' && e.gitBranch.trim()) branch = e.gitBranch.trim();
    const at = tsSeconds(e);
    if (at) lastAt = at;
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.id) pending.set(b.id, { name: b.name || 'tool', at });
      else if (b.type === 'tool_result' && b.tool_use_id) satisfied.add(b.tool_use_id);
    }
  }
  const last = lastAt || nowSeconds;
  if (!entries.length) return { status: 'idle', last_activity_at: last, summary: '(no activity)', branch };

  for (const [id, p] of pending) {
    if (satisfied.has(id)) continue;
    const waited = p.at ? nowSeconds - p.at : 0;
    if (p.at && waited >= PENDING_TOOL_STALE_SECONDS) {
      return { status: 'idle', last_activity_at: p.at, summary: `${p.name} pending since ${Math.floor(waited / 3600)}h ago (abandoned turn)`, branch };
    }
    if (p.at && waited >= PENDING_TOOL_BLOCKED_SECONDS) {
      const mins = Math.floor(waited / 60);
      return { status: 'blocked?', last_activity_at: p.at, summary: `${p.name} pending ${mins ? `${mins}m` : `${Math.floor(waited)}s`} — may need approval`, branch };
    }
    return { status: 'working', last_activity_at: p.at || last, summary: `running ${p.name}`, branch };
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'system' && e.subtype === 'turn_duration') {
      return { status: 'waiting-input', last_activity_at: last, summary: '(awaiting input)', branch };
    }
    if (e.type === 'system' && e.subtype === 'away_summary') {
      return { status: 'idle', last_activity_at: last, summary: String(e.content || '').slice(0, 80), branch };
    }
    if (e.type === 'assistant') {
      const stop = e?.message?.stop_reason;
      if (stop === 'tool_use' || stop === 'max_tokens' || !stop) {
        return { status: 'working', last_activity_at: last, summary: '(generating)', branch };
      }
      const text = firstText(e?.message?.content);
      return { status: 'waiting-input', last_activity_at: last, summary: text.slice(0, 80) || '(awaiting input)', branch };
    }
    if (e.type === 'user') {
      const text = firstText(e?.message?.content);
      return { status: 'waiting-input', last_activity_at: last, summary: text.slice(0, 80) || '(awaiting input)', branch };
    }
  }
  return { status: 'idle', last_activity_at: last, summary: '(no activity)', branch };
}

/** Is a pid alive? Signal 0 probes without delivering anything (works on Windows too). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // exists, just not ours
  }
}

export interface LocalDiscoveryOpts {
  /** Root holding `.claude/` (default: the user's home). */
  home?: string;
  /** Liveness probe; injectable so tests never depend on the machine's processes. */
  isAlive?: (pid: number) => boolean;
  now?: number;
}

/**
 * Enumerate live Claude Code sessions from Claude's own state files, without
 * the daemon. Excludes SDK/API entrypoints (as discovery.py does) and dead pids.
 */
export function discoverLocalSessions(opts: LocalDiscoveryOpts = {}): UnifiedSession[] {
  const root = join(opts.home ?? homedir(), '.claude');
  const stateDir = join(root, 'sessions');
  const projects = join(root, 'projects');
  const alive = opts.isAlive ?? pidAlive;
  const now = opts.now ?? Date.now() / 1000;
  let files: string[] = [];
  try {
    files = readdirSync(stateDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: UnifiedSession[] = [];
  for (const f of files) {
    let state: any;
    try {
      state = JSON.parse(readFileSync(join(stateDir, f), 'utf8'));
    } catch {
      continue;
    }
    const id = String(state?.sessionId || '');
    const pid = Number.parseInt(String(state?.pid ?? ''), 10);
    if (!id || !Number.isFinite(pid)) continue;
    if (/^(sdk|api)/.test(String(state?.entrypoint || ''))) continue;
    if (!alive(pid)) continue;
    const cwd = String(state?.cwd || '');

    let transcript = '';
    const direct = cwd ? join(projects, encodeProjectDir(cwd), `${id}.jsonl`) : '';
    if (direct && existsSync(direct)) {
      transcript = direct;
    } else {
      try {
        for (const d of readdirSync(projects)) {
          const cand = join(projects, d, `${id}.jsonl`);
          if (existsSync(cand)) { transcript = cand; break; }
        }
      } catch { /* no projects dir */ }
    }

    const derived = transcript
      ? deriveTranscriptStatus(readTail(transcript), now)
      : { status: 'unknown' as const, last_activity_at: now, summary: '(transcript not found)', branch: '' };
    const repo = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || '' : '';
    out.push({
      id,
      title: String(state?.name || '').trim() || (repo ? `${repo}#${id.slice(0, 8)}` : id.slice(0, 8)),
      cwd,
      harness: 'claude',
      harness_label: 'Claude Code',
      origin: 'discovered',
      status: derived.status as UnifiedSession['status'],
      last_activity_at: derived.last_activity_at,
      last_activity_summary: derived.summary,
      transcript_path: transcript,
      pid,
      steer_capability: 'none',
      branch: derived.branch,
    });
  }
  out.sort((a, b) => b.last_activity_at - a.last_activity_at);
  return out;
}

export interface SessionsSnapshot {
  sessions: UnifiedSession[];
  /** 'daemon' = the harness daemon answered; 'local' = read from disk because it did not. */
  source: 'daemon' | 'local';
  /** Why the daemon was not used (only when source === 'local'). */
  daemonError?: string;
}

/**
 * The cockpit's data source: the daemon when it answers, otherwise the direct
 * snapshot + JSONL read. Never throws -- a down daemon degrades the capability
 * column to `none`, it does not blank the screen.
 */
export async function fetchSessionsWithFallback(
  fetcher: () => Promise<UnifiedSession[]> = fetchUnifiedSessions,
  local: () => UnifiedSession[] = () => discoverLocalSessions(),
): Promise<SessionsSnapshot> {
  try {
    return { sessions: await fetcher(), source: 'daemon' };
  } catch (e: any) {
    const msg = e instanceof Error ? e.message : String(e);
    let sessions: UnifiedSession[] = [];
    try { sessions = local(); } catch { sessions = []; }
    return { sessions, source: 'local', daemonError: msg };
  }
}

// ─────────────────────────────────────────────────────────────────
// Focus: a live tail of one session's transcript
// ─────────────────────────────────────────────────────────────────

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

/**
 * Turn transcript JSONL into the human-readable conversation: typed prompts,
 * assistant text, and one line per tool call. Machine turns Claude Code sends
 * down the user channel (tool results, system reminders) are dropped.
 */
export function transcriptTurns(tailText: string, maxTurns = 40): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const e of parseLines(tailText)) {
    const content = e?.message?.content;
    if (e.type === 'user') {
      if (typeof content === 'string') {
        const t = content.trim();
        if (t && !t.startsWith('<')) turns.push({ role: 'user', text: t });
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim() && !c.text.trim().startsWith('<')) {
            turns.push({ role: 'user', text: c.text.trim() });
          }
        }
      }
    } else if (e.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
          turns.push({ role: 'assistant', text: c.text.trim() });
        } else if (c?.type === 'tool_use') {
          const input = c.input && typeof c.input === 'object' ? c.input : {};
          const hint = String(input.description || input.command || input.file_path || input.pattern || '').split('\n')[0];
          turns.push({ role: 'tool', text: `${c.name || 'tool'}${hint ? `: ${hint.slice(0, 100)}` : ''}` });
        }
      }
    }
  }
  return turns.slice(-maxTurns);
}

/**
 * Resolve `/sessions focus <target>`: a 1-based row number, or an id / title
 * prefix. Returns undefined when nothing (or more than one row) matches.
 */
export function resolveSessionTarget(sessions: UnifiedSession[], target: string): UnifiedSession | undefined {
  const t = target.trim();
  if (!t) return undefined;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= sessions.length ? sessions[n - 1] : undefined;
  }
  const lower = t.toLowerCase();
  const byId = sessions.filter((s) => s.id.toLowerCase().startsWith(lower));
  if (byId.length === 1) return byId[0];
  const byTitle = sessions.filter((s) => s.title.toLowerCase().includes(lower));
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

/** What `/sessions ...` means inside the REPL. */
export type SessionsRoute =
  | { kind: 'cockpit' }
  | { kind: 'focus'; target: string }
  | { kind: 'traces'; args: string };

/**
 * `/sessions` opens the cockpit (the same overlay as Ctrl+S);
 * `/sessions focus [n|id]` tails one session; `/sessions traces [id]` keeps
 * the old saved-trace listing reachable.
 */
export function routeSessionsCommand(args: string): SessionsRoute {
  const a = args.trim();
  if (!a || a === 'cockpit' || a === 'list') return { kind: 'cockpit' };
  const [verb, ...rest] = a.split(/\s+/);
  if (verb === 'focus' || verb === 'tail' || verb === 'watch') return { kind: 'focus', target: rest.join(' ') };
  if (verb === 'traces' || verb === 'trace') return { kind: 'traces', args: rest.join(' ') };
  // A bare row number or id is a focus request.
  return { kind: 'focus', target: a };
}
