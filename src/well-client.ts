/**
 * Typed HTTP client for the harness daemon's ContextWell API.
 *
 * The well is an O(1) background-refreshed snapshot of ambient context: what
 * branch you're on, what files you've changed, who holds which files right now,
 * what agents are in flight. Instead of paying discovery cost on every turn,
 * the daemon computes it continuously and serves the last good snapshot instantly.
 *
 * Mirrors room-client.ts deliberately — same bearer resolution, same api() helper
 * shape, same "return a degraded result rather than throw" posture.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:8362';

export interface SourceStatus {
  [key: string]: string; // e.g., "git" -> "ok" or "unavailable: ..."
}

export interface RepoState {
  ok: boolean;
  branch?: string;
  head?: string;
  dirty_count?: number;
  dirty_sample?: string[];
  dirty_truncated?: boolean;
  recent_commits?: string[];
  reason?: string;
}

export interface LeaseInfo {
  lease_id: string;
  actor: string;
  target: string;
  expires_ts: string;
  reason: string;
}

export interface LeaseState {
  ok: boolean;
  count?: number;
  leases?: LeaseInfo[];
  expired_or_released?: number;
  unparsable?: number;
  checked_at?: number;
  reason?: string;
}

export interface RoomSnapshot {
  id: string;
  last_seq: number;
  pillars?: Record<string, number>;
}

export interface WellSnapshot {
  ready: boolean;
  reason?: string;
  tier: string;
  built_at?: number;
  age_seconds?: number;
  sources: SourceStatus;
  repo?: RepoState;
  repos?: Record<string, RepoState>;
  leases: LeaseState;
  your_leases?: LeaseInfo[];
  contended_by_others?: LeaseInfo[];
  rooms?: RoomSnapshot[];
  rendered?: string;
}

function daemonUrl(): string {
  return (process.env.AITHER_HARNESS_URL || DEFAULT_URL).replace(/\/$/, '');
}

/**
 * Bearer resolution mirrors the daemon's own order: env, then the file it writes at
 * first start. Returning '' rather than throwing lets the caller emit one clear
 * "start the daemon" message instead of a stack trace.
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
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`not valid JSON: ${text.slice(0, 100)}`);
  }
}

/**
 * Fetch the well snapshot — the ambient context for a working directory and actor.
 *
 * On network error or daemon unavailability, returns a degraded result with ok=false.
 * Never throws.
 */
export async function fetchWellSnapshot(
  cwd: string = '',
  actor: string = '',
  render: boolean = false,
): Promise<WellSnapshot> {
  try {
    const params = new URLSearchParams();
    if (cwd) params.append('cwd', cwd);
    if (actor) params.append('actor', actor);
    if (render) params.append('render', '1');

    const result = await api<WellSnapshot>(
      `/well?${params}`,
    );
    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ready: false,
      reason,
      tier: 'none',
      sources: { error: reason },
      leases: { ok: false, reason },
    };
  }
}
