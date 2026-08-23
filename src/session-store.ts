/**
 * SessionStore — Save/resume CLI conversations.
 *
 * Sessions stored in ~/.aither/sessions/ as JSON.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface SessionMessage {
  role: string;
  content: string;
  timestamp?: string;
  /** Assistant-turn metadata (best-effort). */
  model?: string;
  tools?: string[];
  tokens?: number;
}

export interface SessionEntry {
  sessionId: string;
  agent: string;
  messages: SessionMessage[];
  createdAt: string;
  updatedAt: string;
}

const SESSION_DIR = join(homedir(), '.aither', 'sessions');

function ensureDir(): void {
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function sessionPath(id: string): string {
  return join(SESSION_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

export function saveSession(session: SessionEntry): void {
  ensureDir();
  session.updatedAt = new Date().toISOString();
  writeFileSync(sessionPath(session.sessionId), JSON.stringify(session, null, 2));
}

export function loadSession(id: string): SessionEntry | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function listSessions(limit = 20): Array<{
  sessionId: string;
  agent: string;
  messageCount: number;
  updatedAt: string;
}> {
  ensureDir();
  const files = readdirSync(SESSION_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ name: f, mtime: statSync(join(SESSION_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return files.map(f => {
    try {
      const data: SessionEntry = JSON.parse(readFileSync(join(SESSION_DIR, f.name), 'utf-8'));
      return {
        sessionId: data.sessionId,
        agent: data.agent || 'aither',
        messageCount: data.messages?.length || 0,
        updatedAt: data.updatedAt || new Date(f.mtime).toISOString(),
      };
    } catch {
      return {
        sessionId: f.name.replace('.json', ''),
        agent: 'unknown',
        messageCount: 0,
        updatedAt: new Date(f.mtime).toISOString(),
      };
    }
  });
}

export function deleteSession(id: string): boolean {
  const path = sessionPath(id);
  if (existsSync(path)) {
    unlinkSync(path);
    return true;
  }
  return false;
}

// ── Transcript recording + restore helpers ──────────────────────────

export interface TurnMeta { model?: string; tools?: string[]; tokens?: number }

/**
 * Append a completed chat turn (user + assistant) to the session transcript,
 * persisting it locally AND pushing the FULL transcript to remote. This is what
 * makes `--continue` / `--resume` / `/export` / `/chats` actually work — before
 * this, only user prompts were synced and nothing was written locally.
 */
export function recordTurn(
  sessionId: string, agent: string, user: string, assistant: string, meta: TurnMeta = {},
): SessionEntry {
  const now = new Date().toISOString();
  const entry: SessionEntry = loadSession(sessionId)
    || { sessionId, agent: agent || 'aither', messages: [], createdAt: now, updatedAt: now };
  if (agent) entry.agent = agent;
  // Skip aborted/empty turns entirely — recording the user prompt without an
  // assistant reply leaves a dangling question that poisons resume context.
  if (!assistant || !assistant.trim()) return entry;
  if (user) entry.messages.push({ role: 'user', content: user, timestamp: now });
  entry.messages.push({
    role: 'assistant', content: assistant, timestamp: now,
    model: meta.model, tools: meta.tools, tokens: meta.tokens,
  });
  saveSession(entry);
  void syncSessionToRemote(entry).catch(() => {});
  return entry;
}

/** Most-recently-updated local session id (for `--continue`). */
export function mostRecentSessionId(): string | null {
  const list = listSessions(1);
  return list.length ? list[0].sessionId : null;
}

/** A compact "conversation so far" string for the session_context channel. */
export function buildContextSummary(messages: SessionMessage[], maxTurns = 8, maxChars = 1800): string {
  const recent = messages.slice(-maxTurns * 2);
  let s = recent.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  if (s.length > maxChars) s = '…' + s.slice(-maxChars);
  return s;
}

/** Total recorded assistant tokens for a session. */
export function sessionTokens(entry: SessionEntry): number {
  return entry.messages.reduce((n, m) => n + (m.tokens || 0), 0);
}

/** Render a transcript as Markdown (for /export). */
export function transcriptMarkdown(entry: SessionEntry): string {
  const lines = [
    `# AitherShell session ${entry.sessionId}`,
    `Agent: ${entry.agent}  ·  ${entry.messages.length} messages  ·  ${entry.updatedAt}`,
    '',
  ];
  for (const m of entry.messages) {
    lines.push(m.role === 'user' ? `## You` : `## ${entry.agent}${m.model ? ` (${m.model})` : ''}`);
    lines.push('', m.content, '');
  }
  return lines.join('\n');
}

// ── Remote Sync — push/pull sessions via Genesis /session/sync/* ─────

let _genesisUrl: string | null = null;
let _authToken: string | null = null;

export function configureRemoteSync(genesisUrl: string, authToken: string | null): void {
  _genesisUrl = genesisUrl;
  _authToken = authToken;
}

export async function syncSessionToRemote(session: SessionEntry): Promise<void> {
  if (!_genesisUrl) return;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (_authToken) headers['Authorization'] = `Bearer ${_authToken}`;

    await fetch(`${_genesisUrl}/session/sync/save`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: session.sessionId,
        agent: session.agent,
        messages: session.messages,
        client_type: 'cli',
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {}); // fire-and-forget, don't block shell
  } catch { /* silent */ }
}

export async function loadRemoteSession(sessionId: string): Promise<SessionEntry | null> {
  if (!_genesisUrl) return null;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (_authToken) headers['Authorization'] = `Bearer ${_authToken}`;

    const res = await fetch(`${_genesisUrl}/session/sync/load`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const s = data.session;
    if (!s) return null;
    return {
      sessionId: s.session_id,
      agent: s.agent || 'aither',
      messages: s.messages || [],
      createdAt: s.created_at || '',
      updatedAt: s.updated_at || '',
    };
  } catch {
    return null;
  }
}

export async function listRemoteSessions(limit = 20): Promise<Array<{
  sessionId: string;
  agent: string;
  messageCount: number;
  updatedAt: string;
  clientType: string;
}>> {
  if (!_genesisUrl) return [];
  try {
    const headers: Record<string, string> = {};
    if (_authToken) headers['Authorization'] = `Bearer ${_authToken}`;

    const res = await fetch(`${_genesisUrl}/session/sync/list?limit=${limit}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.sessions || []).map((s: any) => ({
      sessionId: s.session_id,
      agent: s.agent || 'aither',
      messageCount: s.message_count || 0,
      updatedAt: s.updated_at || '',
      clientType: s.client_type || 'unknown',
    }));
  } catch {
    return [];
  }
}
