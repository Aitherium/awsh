/**
 * AitherRelay client — native IRC-style group chat (humans + agents) over the
 * relay WebSocket (`/ws/chat`, served by CommunicationCore). Agents joined to a
 * channel respond in-line (server-side `_trigger_group_chat`), so this is the
 * same multiagent room model as the DaoOS room.
 *
 * Protocol (client → server):
 *   { type: 'join',    channel, nick, token }
 *   { type: 'message', channel, content }
 *   { type: 'typing',  channel }
 *   { type: 'command', command: '/part', channel }
 * (server → client): history | message | join | part | userlist | typing | error | system
 *
 * Auth: the token rides in the join payload (the relay resolves identity from
 * it) — no custom WS headers needed, so the platform global WebSocket works.
 */

export interface RelayMessage {
  channel: string;
  nick: string;
  content: string;
  agent?: boolean;
  timestamp?: number | string;
  id?: string;
}

export interface RelayUser {
  nick: string;
  is_agent?: boolean;
  status?: string;
}

export type RelayStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RelayHandlers {
  onStatus?: (status: RelayStatus, detail?: string) => void;
  onHistory?: (channel: string, messages: RelayMessage[]) => void;
  onMessage?: (msg: RelayMessage) => void;
  onJoin?: (nick: string, channel: string, isAgent?: boolean) => void;
  onPart?: (nick: string, channel: string) => void;
  onUserlist?: (channel: string, users: RelayUser[]) => void;
  onTyping?: (nick: string, channel: string) => void;
  onError?: (message: string) => void;
}

export interface RelayChannel {
  name: string;
  topic?: string;
  mode?: string;
  user_count?: number;
}

/** CommunicationCore's relay on a fleet host: root-mounted on 8205, TLS-only (the
 *  shell sets NODE_TLS_REJECT_UNAUTHORIZED=0 for its self-signed cert). */
export const LOCAL_RELAY_URL = 'wss://127.0.0.1:8205/ws/chat';

/** The hosted relay socket (measured 2026-10-02: wss://relay.aitherium.com/ws/chat
 *  answers 101; irc.aitherium.com answers 502). */
export const HOSTED_RELAY_URL = 'wss://relay.aitherium.com/ws/chat';

/** Resolve the relay WS URL: AITHER_RELAY_URL override, else local CommunicationCore.
 *  Off a fleet host the local port refuses; RelayClient then moves a signed-in
 *  session to HOSTED_RELAY_URL (see relayFallbackUrl). */
export function resolveRelayUrl(): string {
  const env = process.env.AITHER_RELAY_URL;
  if (env) return env.replace(/\/+$/, '');
  return LOCAL_RELAY_URL;
}

/**
 * Pure: where to reconnect after a socket closed. Returns the hosted relay URL only
 * when ALL hold: the socket never opened (the port refused, not a dropped session),
 * the URL is the local default, AITHER_RELAY_URL is unset (an explicit choice always
 * wins), and the session is signed in (the hosted relay resolves identity from the
 * token). Otherwise null: retry the same URL.
 */
export function relayFallbackUrl(
  currentUrl: string,
  opts: { everOpened: boolean; token?: string; envUrl?: string },
): string | null {
  if (opts.everOpened || !opts.token || opts.envUrl) return null;
  if (currentUrl.replace(/\/+$/, '') !== LOCAL_RELAY_URL) return null;
  return HOSTED_RELAY_URL;
}

export class RelayClient {
  private ws: any = null;
  private url: string;
  private everOpened = false;  // any socket on this.url reached 'open'
  private readonly token?: string;
  readonly nick: string;
  private channel = '#general';
  private readonly handlers: RelayHandlers;
  private closedByUser = false;
  private backoff = 1000;
  private outbox: string[] = [];  // messages typed while the socket is down

  constructor(opts: { url?: string; token?: string; nick: string; handlers: RelayHandlers }) {
    this.url = (opts.url || resolveRelayUrl()).replace(/\/+$/, '');
    this.token = opts.token;
    this.nick = opts.nick;
    this.handlers = opts.handlers;
  }

  get currentChannel(): string { return this.channel; }

  /** Join payload. When authenticated, OMIT the requested nick — the relay
   *  rejects a join whose nick doesn't match the token's identity nick. Letting
   *  the server pick the identity nick avoids that hard failure. Anonymous
   *  sessions send their chosen nick. */
  private joinPayload(channel: string): Record<string, unknown> {
    const p: Record<string, unknown> = { type: 'join', channel };
    if (this.token) p.token = this.token; else p.nick = this.nick;
    return p;
  }

  /** HTTP base for the relay REST API (derive from the ws url). */
  private httpBase(): string {
    return this.url.replace(/^ws/, 'http').replace(/\/ws\/chat$/, '');
  }

  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  /** List channels via REST for the picker. `scope` selects platform (default —
   *  public + the channels you can access, including workspace channels you're a
   *  member of), 'community', or 'workspace:<slug>'. Anonymous sessions get the
   *  public global/platform channels. Never throws. */
  async listChannels(scope = 'platform'): Promise<RelayChannel[]> {
    try {
      const u = `${this.httpBase()}/v1/channels?scope=${encodeURIComponent(scope)}&nick=${encodeURIComponent(this.nick)}`;
      const r = await fetch(u, { headers: this.authHeaders(), signal: AbortSignal.timeout(6000) });
      if (!r.ok) return [];
      const data = await r.json() as any;
      const raw = Array.isArray(data) ? data : (data.channels || data.items || []);
      return raw.map((c: any) => ({
        name: typeof c === 'string' ? c : (c.name || c.channel || c.id),
        topic: c.topic,
        mode: c.mode,
        user_count: c.user_count ?? c.users ?? c.member_count,
      })).filter((c: RelayChannel) => c.name);
    } catch { return []; }
  }

  /** Fetch messages OLDER than `beforeTimestamp` (ISO) for scrollback. Returns
   *  them oldest→newest. Never throws. */
  async loadOlder(beforeTimestamp: string, limit = 50): Promise<RelayMessage[]> {
    try {
      const ch = this.channel.replace(/^#/, '');
      const u = `${this.httpBase()}/v1/channels/${encodeURIComponent(ch)}/messages`
        + `?limit=${limit}&before=${encodeURIComponent(beforeTimestamp)}`;
      const r = await fetch(u, { headers: this.authHeaders(), signal: AbortSignal.timeout(8000) });
      if (!r.ok) return [];
      const data = await r.json() as any;
      const msgs = (Array.isArray(data) ? data : (data.messages || [])) as RelayMessage[];
      return msgs.slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    } catch { return []; }
  }

  /** Connect and join `channel`. Reconnects with backoff until disconnect(). */
  connect(channel: string): void {
    this.channel = channel || this.channel;
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const WS: any = (globalThis as any).WebSocket;
    if (!WS) { this.handlers.onError?.('WebSocket unavailable (needs Node 22+/bun).'); return; }
    this.handlers.onStatus?.('connecting');
    let ws: any;
    try { ws = new WS(this.url); } catch (e: any) {
      this.handlers.onError?.(`relay connect failed: ${e?.message || e}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.addEventListener('open', () => {
      opened = true;
      this.everOpened = true;
      this.backoff = 1000;
      this.handlers.onStatus?.('open');
      this.sendRaw(this.joinPayload(this.channel));
      // Flush anything typed while we were down (after the rejoin).
      if (this.outbox.length) {
        const pending = this.outbox.splice(0);
        for (const content of pending) this.sendRaw({ type: 'message', channel: this.channel, content });
      }
    });
    ws.addEventListener('message', (ev: any) => this.onData(ev.data));
    ws.addEventListener('close', () => {
      this.ws = null;
      if (this.closedByUser) { this.handlers.onStatus?.('closed'); return; }
      const next = opened ? null : relayFallbackUrl(this.url, {
        everOpened: this.everOpened, token: this.token, envUrl: process.env.AITHER_RELAY_URL,
      });
      if (next) {
        // Off a fleet host: the local relay port refused. Move to the hosted relay now
        // (no backoff) -- for the rest of this client's life.
        this.url = next;
        this.handlers.onStatus?.('reconnecting', `local relay refused; using ${next}`);
        this.open();
        return;
      }
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => { /* a close event follows; reconnect there */ });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.handlers.onStatus?.('reconnecting');
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    setTimeout(() => { if (!this.closedByUser) this.open(); }, wait);
  }

  private onData(raw: any): void {
    let d: any;
    try { d = JSON.parse(String(raw)); } catch { return; }
    switch (d.type) {
      case 'history':
        this.handlers.onHistory?.(d.channel, (d.messages || []) as RelayMessage[]);
        break;
      case 'message':
        this.handlers.onMessage?.(d as RelayMessage);
        break;
      case 'join':
        this.handlers.onJoin?.(d.nick, d.channel, d.is_agent);
        break;
      case 'part':
        this.handlers.onPart?.(d.nick, d.channel);
        break;
      case 'userlist':
        this.handlers.onUserlist?.(d.channel, (d.users || []) as RelayUser[]);
        break;
      case 'typing':
        this.handlers.onTyping?.(d.nick, d.channel);
        break;
      case 'error':
      case 'system':
        this.handlers.onError?.(d.message || d.content || 'relay error');
        break;
      default:
        break;
    }
  }

  /** Switch channels (server sends fresh history + userlist). */
  join(channel: string): void {
    this.channel = channel.startsWith('#') ? channel : `#${channel}`;
    this.sendRaw(this.joinPayload(this.channel));
  }

  /** Send a chat message to the current channel. Queues if the socket is mid-
   *  reconnect so nothing is silently dropped (flushed on the next open). */
  send(content: string): void {
    const c = (content || '').trim();
    if (!c) return;
    const open = this.ws && this.ws.readyState === 1 /* OPEN */;
    if (open) this.sendRaw({ type: 'message', channel: this.channel, content: c });
    else { this.outbox.push(c); if (this.outbox.length > 100) this.outbox.shift(); }
  }

  typing(): void { this.sendRaw({ type: 'typing', channel: this.channel }); }

  part(channel?: string): void {
    this.sendRaw({ type: 'command', command: '/part', channel: channel || this.channel });
  }

  disconnect(): void {
    this.closedByUser = true;
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
  }

  private sendRaw(obj: any): void {
    try { this.ws?.send(JSON.stringify(obj)); } catch { /* dropped; reconnect will rejoin */ }
  }
}
