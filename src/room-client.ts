/**
 * Typed HTTP client for the harness daemon's AitherAeon room API.
 *
 * The room is where every agent surface becomes visible at once: Claude Code tabs,
 * adk agent loops, sovereign Aither agents, the SixPillarsKernel tick and Flux, all
 * on one ordered stream with every event filed under one of the six pillars.
 *
 * Mirrors sessions-client.ts deliberately — same bearer resolution, same api()
 * helper shape, same "return a degraded result rather than throw" posture. Two
 * clients for one daemon that disagree about how to reach it is how a working
 * daemon starts looking broken.
 *
 * The pillar vocabulary is NOT redeclared here. It comes from
 * aither-events.generated.ts, which is generated from AitherEventSpine.py and gated
 * by check_event_protocol_parity.py (AE004) — a hand-copied lane list would drift
 * from the producers silently, and a lane that silently stops matching its producer
 * renders empty, which is indistinguishable from "nothing happened".
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  PILLARS,
  type AitherEvent,
  type Pillar,
} from './aither-events.generated.js';

const DEFAULT_URL = 'http://127.0.0.1:8362';

export interface RoomParticipant {
  kind: string;
  id: string;
  name: string;
  events: number;
  idle_seconds: number;
  active: boolean;
}

export interface RoomInfo {
  id: string;
  title: string;
  last_seq: number;
  participants: RoomParticipant[];
  pillars: Record<string, number>;
  transcript: string;
}

export interface RoomEvents {
  events: AitherEvent[];
  last_seq: number;
  pillars: Record<string, number>;
}

/** What the view needs, plus an honest degraded flag. */
export interface RoomSnapshot {
  ok: boolean;
  /** Why the room is unavailable. Rendered verbatim — never a blank room. */
  reason: string;
  info: RoomInfo | null;
  events: AitherEvent[];
  lastSeq: number;
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

export async function getRoom(room = 'main'): Promise<RoomInfo> {
  return api<RoomInfo>(`/rooms/${encodeURIComponent(room)}`);
}

export async function getRoomEvents(
  room = 'main',
  since = 0,
  limit = 0,
): Promise<RoomEvents> {
  const q = new URLSearchParams({ since: String(since) });
  if (limit) q.set('limit', String(limit));
  return api<RoomEvents>(`/rooms/${encodeURIComponent(room)}/events?${q}`);
}

/**
 * One poll for everything the view needs.
 *
 * Fails SOFT and SAYS SO: a daemon that is down yields ok=false with the reason,
 * never an empty-but-successful-looking snapshot. An empty room and an unreachable
 * room look identical on screen unless one of them is labelled, and "no agents are
 * working" is exactly the wrong thing to tell someone whose agents are all working.
 */
export async function fetchRoomSnapshot(
  room = 'main',
  since = 0,
): Promise<RoomSnapshot> {
  try {
    const [info, evs] = await Promise.all([
      getRoom(room),
      getRoomEvents(room, since),
    ]);
    return {
      ok: true,
      reason: '',
      info,
      events: evs.events || [],
      lastSeq: evs.last_seq ?? info.last_seq ?? 0,
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    const friendly = /fetch failed|ECONNREFUSED/i.test(msg)
      ? `harness daemon unreachable at ${daemonUrl()} — start it with: adk harness serve`
      : msg;
    return { ok: false, reason: friendly, info: null, events: [], lastSeq: since };
  }
}

/**
 * Bucket events into the six pillar lanes.
 *
 * Events with `pillar === null` are the CONVERSATION SURFACE (answer tokens,
 * keepalives, lifecycle) and are returned separately rather than forced into a lane.
 * Putting unknown events in a lane is how a lane stops meaning anything.
 */
export function bucketByPillar(events: AitherEvent[]): {
  lanes: Record<Pillar, AitherEvent[]>;
  surface: AitherEvent[];
} {
  const lanes = {} as Record<Pillar, AitherEvent[]>;
  for (const p of PILLARS) lanes[p] = [];
  const surface: AitherEvent[] = [];

  for (const ev of events) {
    const pillar = ev.pillar;
    if (pillar && pillar in lanes) lanes[pillar as Pillar].push(ev);
    else surface.push(ev);
  }
  return { lanes, surface };
}

/**
 * One-line label for an event row: the tool, file, prompt or text if present.
 *
 * Collapses ALL whitespace, including newlines. Real payloads carry multi-line text
 * — a pasted prompt, a hook message, a command with a heredoc — and a raw `\n` here
 * breaks out of its lane and corrupts every row below it, because the view lays out
 * one event per line. Measured against live Claude Code traffic: a two-line prompt
 * split one lane into two mis-indented rows.
 */
export function eventDetail(ev: AitherEvent): string {
  const p = (ev.payload || {}) as Record<string, unknown>;
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();
  for (const key of ['tool', 'file_path', 'command', 'prompt', 'text', 'phase_name', 'model']) {
    const v = p[key];
    if (typeof v === 'string' && clean(v)) return clean(v);
  }
  if (typeof p.phase === 'string') return clean(p.phase);
  return '';
}

/** "3 agents · 2 active · 41 events" — a roster summary for the footer. */
export function summarizeRoom(info: RoomInfo | null): string {
  if (!info) return 'no room';
  const people = info.participants || [];
  const active = people.filter((p) => p.active).length;
  const total = Object.values(info.pillars || {}).reduce((a, b) => a + b, 0);
  return `${people.length} participant(s) · ${active} active · ${total} pillar event(s) · seq ${info.last_seq}`;
}
