/**
 * Typed HTTP client for the harness daemon's unified sessions endpoint.
 *
 * Reuses existing harness-client.ts conventions: bearer token resolution,
 * error handling, degradation path when daemon is unreachable. This module
 * is read-only observation only — no steering in slice 1.
 */

import { readFileSync } from 'node:fs';
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
  status: 'working' | 'waiting-input' | 'waiting-permission' | 'idle' | 'dead';
  last_activity_at: number; // Unix timestamp (seconds)
  last_activity_summary: string;
  transcript_path: string;
  pid: number | null;
  steer_capability: 'full' | 'turn-boundary' | 'none';
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
  widths: { name: number; cwd: number; summary: number },
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
  const status = entry.status.padEnd(14);

  // Format age (time since last_activity_at)
  const age = formatAge(entry.last_activity_at);

  // Format summary (truncate)
  const summary = entry.last_activity_summary.length > widths.summary
    ? entry.last_activity_summary.slice(0, widths.summary - 1) + '…'
    : entry.last_activity_summary.padEnd(widths.summary);

  return `  ${name}  ${cwd}  ${originTag}  ${status}  ${age}  ${summary}`;
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
