/**
 * Off a fleet host the local relay port (127.0.0.1:8205) refuses. A signed-in session
 * must move to the hosted relay socket; AITHER_RELAY_URL always wins.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOSTED_RELAY_URL, LOCAL_RELAY_URL, RelayClient, relayFallbackUrl, resolveRelayUrl,
} from '../src/relay.js';

const realWS = (globalThis as any).WebSocket;
const realEnv = process.env.AITHER_RELAY_URL;
afterEach(() => {
  (globalThis as any).WebSocket = realWS;
  if (realEnv === undefined) delete process.env.AITHER_RELAY_URL; else process.env.AITHER_RELAY_URL = realEnv;
});

/** A fake WebSocket: the local URL refuses (close without open), any other opens. */
function installFakeWS(refuse: (url: string) => boolean) {
  const opened: string[] = [];
  const sent: { url: string; data: any }[] = [];
  class FakeWS {
    readyState = 0;
    private l: Record<string, ((ev?: any) => void)[]> = {};
    constructor(public url: string) {
      opened.push(url);
      queueMicrotask(() => {
        if (refuse(url)) { this.emit('error'); this.emit('close'); return; }
        this.readyState = 1; this.emit('open');
      });
    }
    addEventListener(t: string, f: (ev?: any) => void) { (this.l[t] ||= []).push(f); }
    send(d: string) { sent.push({ url: this.url, data: JSON.parse(d) }); }
    close() { this.readyState = 3; }
    private emit(t: string) { for (const f of this.l[t] || []) f({}); }
  }
  (globalThis as any).WebSocket = FakeWS;
  return { opened, sent };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
// The credential guard resolves the relay host before it dials (on Linux), so a
// fixed 20 ms is a race on a CI runner. Wait for the outcome instead, bounded.
const waitFor = async (done: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

test('resolveRelayUrl: AITHER_RELAY_URL wins, else the local default', () => {
  process.env.AITHER_RELAY_URL = 'wss://example.test/ws/chat/';
  assert.equal(resolveRelayUrl(), 'wss://example.test/ws/chat');
  delete process.env.AITHER_RELAY_URL;
  assert.equal(resolveRelayUrl(), LOCAL_RELAY_URL);
});

test('relayFallbackUrl: hosted only for a refused local default with a token and no override', () => {
  assert.equal(relayFallbackUrl(LOCAL_RELAY_URL, { everOpened: false, token: 't' }), HOSTED_RELAY_URL);
  assert.equal(relayFallbackUrl(LOCAL_RELAY_URL, { everOpened: false }), null, 'anonymous stays local');
  assert.equal(relayFallbackUrl(LOCAL_RELAY_URL, { everOpened: true, token: 't' }), null, 'a dropped session retries');
  assert.equal(relayFallbackUrl(LOCAL_RELAY_URL, { everOpened: false, token: 't', envUrl: 'wss://x' }), null);
  assert.equal(relayFallbackUrl('wss://other/ws/chat', { everOpened: false, token: 't' }), null);
});

test('hosted fallback chosen when the local port refuses (signed in)', async () => {
  delete process.env.AITHER_RELAY_URL;
  const { opened, sent } = installFakeWS((u) => u === LOCAL_RELAY_URL);
  const statuses: string[] = [];
  const c = new RelayClient({
    url: resolveRelayUrl(), token: 'tok', nick: 'me',
    handlers: { onStatus: (s, d) => statuses.push(`${s}${d ? `:${d}` : ''}`) },
  });
  c.connect('#general');
  await waitFor(() => sent.some((s) => s.data.type === 'join'));
  c.disconnect();
  assert.deepEqual(opened, [LOCAL_RELAY_URL, HOSTED_RELAY_URL]);
  assert.ok(statuses.includes('open'), statuses.join(','));
  const join = sent.find((s) => s.data.type === 'join');
  assert.equal(join?.url, HOSTED_RELAY_URL);
  assert.equal(join?.data.token, 'tok');
});

test('AITHER_RELAY_URL still wins: a refused override is retried, never swapped for hosted', async () => {
  process.env.AITHER_RELAY_URL = LOCAL_RELAY_URL;
  const { opened } = installFakeWS(() => true);
  const c = new RelayClient({ url: resolveRelayUrl(), token: 'tok', nick: 'me', handlers: {} });
  c.connect('#general');
  await tick();
  c.disconnect();
  assert.deepEqual(opened, [LOCAL_RELAY_URL]);
});
