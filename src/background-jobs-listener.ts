/**
 * Persistent background job listener via /chat/session-events SSE.
 *
 * Connects once at startup and keeps the connection open for the TUI lifetime,
 * auto-reconnecting on drop. Emits typed events (job_started, job_update, job_gate,
 * job_done, heartbeat) as they stream from the server.
 *
 * IMPORTANT: This is background-safe. All listeners are called within try/catch
 * so a rendering fault never crashes the TUI. Listeners can queue work until
 * turn boundaries (check queuedInputs length).
 */

import type { SSEEvent } from './client.js';
import { GenesisClient } from './client.js';

export interface JobStartedEvent {
  type: 'job_started';
  job_id: string;
  label: string;
  session_id: string;
  ts: number;
}

export interface JobUpdateEvent {
  type: 'job_update';
  job_id: string;
  stage: string;
  status: string;
  session_id: string;
  ts: number;
}

export interface JobGateEvent {
  type: 'job_gate';
  job_id: string;
  gate_id: string;
  gate_type: string;
  question: string;
  session_id: string;
  ts: number;
}

export interface JobDoneEvent {
  type: 'job_done';
  job_id: string;
  status: 'completed' | 'failed';
  result_summary?: string;
  error?: string;
  session_id: string;
  ts: number;
}

export interface HeartbeatEvent {
  type: 'heartbeat';
  ts: number;
}

/**
 * A late, out-of-band continuation of a turn that has ALREADY closed.
 *
 * The grounded pipeline is detached from the turn (the turn ends as soon as the
 * answer is final), so when it finishes and turns out to have done MATERIAL work
 * — tools actually fired, or artifacts were produced — it publishes the delta
 * here instead of holding the chat open for it.
 *
 * It is strictly ADDITIVE: `text` is already the delta vs. what's on screen, and
 * it is rendered as a distinct appended block. It never rewrites the answer the
 * user already read. A reword / near-duplicate is never published at all.
 */
export interface ChatRefinementEvent {
  type: 'chat_refinement';
  session_id: string;
  agent?: string;
  model?: string;
  reason?: string;
  text?: string;
  artifacts?: Array<Record<string, any>>;
  ts: number;
}

export type JobEventType =
  | JobStartedEvent
  | JobUpdateEvent
  | JobGateEvent
  | JobDoneEvent
  | ChatRefinementEvent
  | HeartbeatEvent;

export type JobEventListener = (event: JobEventType) => void;

export interface BackgroundJobsListenerOpts {
  client: GenesisClient;
  sessionId: string;
  abortSignal?: AbortSignal;
}

/** Manage a persistent SSE connection to /chat/session-events. */
export class BackgroundJobsListener {
  private client: GenesisClient;
  private sessionId: string;
  private abortController: AbortController;
  private parentAbort: AbortSignal | undefined;
  private listeners: JobEventListener[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private closed = false;

  constructor(opts: BackgroundJobsListenerOpts) {
    this.client = opts.client;
    this.sessionId = opts.sessionId;
    this.parentAbort = opts.abortSignal;
    this.abortController = new AbortController();
  }

  /** Register a callback that fires on each job event. */
  onEvent(listener: JobEventListener): void {
    this.listeners.push(listener);
  }

  /** Start the background connection. */
  start(): void {
    if (this.closed) return;
    this.connect();
  }

  /** Close the listener and clean up timers. */
  close(): void {
    this.closed = true;
    this.abortController.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }

  private async connect(): Promise<void> {
    if (this.closed || this.abortController.signal.aborted) return;

    try {
      await this.streamEvents();
    } catch (err: any) {
      // Stream ended or connection failed — schedule reconnect
      if (!this.closed && !this.abortController.signal.aborted && err?.name !== 'AbortError') {
        this.scheduleReconnect();
      }
    }
  }

  private async streamEvents(): Promise<void> {
    const url = `${this.client.baseUrl}/chat/session-events?session_id=${encodeURIComponent(
      this.sessionId,
    )}`;

    try {
      const r = await fetch(url, {
        headers: { 'X-Caller-Type': 'PLATFORM' },
        // Parent abort (shell exit) + our own abort controller
        signal: AbortSignal.any([this.parentAbort || { aborted: false }, this.abortController.signal] as any),
      });

      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }

      const body = r.body as ReadableStream<Uint8Array> | null;
      if (!body) throw new Error('No response body');

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      this.reconnectDelay = 1000;  // reset backoff on successful connect

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            if (!part.trim()) continue;
            const event = this.parseBlock(part);
            if (event) this.emitEvent(event);
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;  // parent or local abort — propagate
      throw err;  // transient error — will reconnect
    }
  }

  private parseBlock(block: string): JobEventType | null {
    let eventType: string | undefined;
    let eventData: Record<string, any> | null = null;

    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try {
          eventData = JSON.parse(line.slice(6));
        } catch {
          return null;
        }
      }
    }

    if (!eventData) return null;
    if (eventType && !eventData.type) eventData.type = eventType;

    return eventData as JobEventType;
  }

  private emitEvent(event: JobEventType): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err: any) {
        // Listener faults are silent — never crash the TUI. Log to stderr so the
        // user can diagnose if they enable debug logging, but the shell keeps running.
        process.stderr.write(
          `[background-jobs-listener] event handler error: ${err?.message || err}\n`,
        );
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    const delay = Math.min(this.reconnectDelay, this.maxReconnectDelay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.connect();
      }
    }, delay);
  }
}
