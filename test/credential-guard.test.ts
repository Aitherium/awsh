/**
 * No credential reaches a loopback port another account holds (PR #10908 review).
 *
 * awnix derives every user's daemon ports from a public formula, so another local user
 * can bind ours while our daemon is down. The account bearer (AITHER_CLOUD_URL points at
 * the loopback agent port), the harness bearer and the daemon token must all be withheld
 * from a listener the kernel says is not ours -- and still reach our own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  guardFetch, credentialTargetProblem, assertCredentialTarget, canonicalAddr, type GuardEnv,
} from '../src/credential-guard.js';
import { connectTargets } from '../src/client.js';
import { RelayClient } from '../src/relay.js';

const ME = 1000;
const OTHER = 1001;
const V4_LO = '0100007F';
const V6_LO = '00000000000000000000000001000000';

/** A fake /proc/net with LISTEN rows [address hex, port, uid]. */
function table(tcp: Array<[string, number, number]>, tcp6: Array<[string, number, number]> = []): string {
  const net = mkdtempSync(join(tmpdir(), 'awsh-guard-net-'));
  const hdr = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid\n';
  const body = (rows: Array<[string, number, number]>) => rows.map(([a, p, u], i) =>
    `   ${i}: ${a}:${p.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A ` +
    `00000000:00000000 00:00000000 00000000 ${u}\n`).join('');
  writeFileSync(join(net, 'tcp'), hdr + body(tcp));
  writeFileSync(join(net, 'tcp6'), hdr + body(tcp6));
  return net;
}

/** This fake machine: lo + a LAN NIC 192.168.1.50 / fd00::50, named `desk`. */
const LAN_IP = '192.168.1.50';
const LAN_HEX = '3201A8C0';                              // 192.168.1.50 in /proc/net order
const V4_ANY = '00000000';
const V6_ANY = '0'.repeat(32);
const DNS: Record<string, string[]> = {
  'desk': [LAN_IP],
  'desk.lan': ['::ffff:192.168.1.50'],                    // IPv4-mapped answer
  'gateway.aitherium.com': ['104.18.2.3'],
};
const linux = (procNet: string, hostname = 'desk'): GuardEnv => ({
  procNet, uid: ME, linux: true,
  interfaces: () => ['127.0.0.1', '::1', LAN_IP, 'fd00::50'],
  hostname: () => hostname,
  lookup: async (h: string) => {
    if (DNS[h]) return DNS[h];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: 'ENOTFOUND' });
  },
});

/** A fetch that records what it was handed instead of dialling. */
function recorder() {
  const sent: Array<{ url: string; headers: any }> = [];
  const inner = (async (input: any, init?: any) => {
    sent.push({ url: String(input), headers: init?.headers });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { sent, inner };
}

const BEARER = { Authorization: 'Bearer aither_sk_live_fake', 'X-API-Key': 'aither_sk_live_fake' };

test("another account's listener on our agent port receives no account bearer", async () => {
  const net = table([[V4_LO, 10001, OTHER]]);
  const { sent, inner } = recorder();
  const f = guardFetch(inner, linux(net));
  await assert.rejects(f('http://127.0.0.1:10001/chat/stream', { headers: BEARER }),
    /refused to send credentials.*uid 1001/);
  await assert.rejects(f('http://127.0.0.1:10001/x', { headers: { 'X-Aither-Local-Token': 't' } }));
  await assert.rejects(f('http://127.0.0.1:10001/x', { headers: new Headers({ authorization: 'Bearer h' }) }));
  assert.equal(sent.length, 0, 'nothing reached the squatter');
});

test('our own listener receives the bearer', async () => {
  const net = table([[V4_LO, 10001, ME]], [[V6_LO, 10001, ME]]);
  const { sent, inner } = recorder();
  const f = guardFetch(inner, linux(net));
  const r = await f('http://localhost:10001/chat/stream', { headers: BEARER });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.Authorization, BEARER.Authorization);
});

test('a squatter on the other loopback blocks localhost', async () => {
  const net = table([[V4_LO, 10002, ME]], [[V6_LO, 10002, OTHER]]);
  const { sent, inner } = recorder();
  await assert.rejects(guardFetch(inner, linux(net))('http://localhost:10002/sessions',
    { headers: { Authorization: 'Bearer harness' } }));
  assert.equal(sent.length, 0);
});

test('Linux fails closed when it cannot tell who listens', async () => {
  assert.match((await credentialTargetProblem('http://127.0.0.1:10001',
    linux(join(tmpdir(), 'awsh-no-proc-net-does-not-exist'))))!, /cannot tell/);
  assert.match((await credentialTargetProblem('http://127.0.0.1:10001',
    { procNet: table([[V4_LO, 10001, ME]]), uid: null, linux: true }))!, /cannot tell/);
});

test("root's listener and a DNAT'd port (no LISTEN row) are not a squatter", async () => {
  assert.equal(await credentialTargetProblem('http://127.0.0.1:8150', linux(table([[V4_LO, 8150, 0]]))), null);
  assert.equal(await credentialTargetProblem('http://127.0.0.1:8150', linux(table([]))), null);
});

test('requests without credentials, remote URLs and non-Linux pass untouched', async () => {
  const net = table([[V4_LO, 10001, OTHER]]);
  const { sent, inner } = recorder();
  const f = guardFetch(inner, linux(net));
  await f('http://127.0.0.1:10001/health');
  await f('http://127.0.0.1:10001/health', { headers: { Authorization: '' } });
  await f('https://gateway.aitherium.com/v1/models', { headers: BEARER });
  assert.equal(sent.length, 3);
  assert.equal(await credentialTargetProblem('http://127.0.0.1:10001',
    { procNet: net, uid: ME, linux: false }), null);
});

test('the node:http sinks share the same check', async () => {
  const net = table([[V4_LO, 8084, OTHER]]);
  await assert.rejects(assertCredentialTarget('https://127.0.0.1:8084/voice/synthesize', BEARER, linux(net)));
  await assertCredentialTarget('https://127.0.0.1:8084/voice/synthesize', {}, linux(net));
});

test('0.0.0.0, [::] and *.localhost are loopback', async () => {
  assert.deepEqual(connectTargets('0.0.0.0'), ['127.0.0.1']);
  assert.deepEqual(connectTargets('[::]'), ['::1']);
  assert.deepEqual(connectTargets('agent.localhost'), ['127.0.0.1', '::1']);
  assert.deepEqual(connectTargets('AGENT.LOCALHOST.'), ['127.0.0.1', '::1']);
  assert.deepEqual(connectTargets('localhost.evil.test'), []);
  const net = table([[V4_LO, 10001, OTHER]], [[V6_LO, 10001, OTHER]]);
  for (const url of ['http://0.0.0.0:10001', 'http://0:10001', 'http://[::]:10001',
    'http://agent.localhost:10001']) {
    assert.match((await credentialTargetProblem(url, linux(net))) ?? '', /uid 1001/, url);
  }
});

test('login and 2FA bodies and ?token= queries are credentials too', async () => {
  const net = table([[V4_LO, 8115, OTHER]]);
  const { sent, inner } = recorder();
  const f = guardFetch(inner, linux(net));
  await assert.rejects(f('http://localhost:8115/auth/login',
    { method: 'POST', body: JSON.stringify({ username: 'me', password: 'hunter2' }) }));
  await assert.rejects(f('http://localhost:8115/auth/2fa/verify',
    { method: 'POST', body: JSON.stringify({ temp_token: 't', code: '123456' }) }));
  await assert.rejects(f('http://localhost:8115/x?token=secret-in-query'),
    (e: Error) => !e.message.includes('secret-in-query'));
  await f('http://localhost:8115/auth/alpha-capacity', { method: 'POST', body: JSON.stringify({ q: 1 }) });
  assert.equal(sent.length, 1, 'only the credential-free request went out');
});

/** A fake WebSocket that records every frame it is asked to send. */
function fakeWS() {
  const opened: string[] = [];
  const frames: string[] = [];
  (globalThis as any).WebSocket = class {
    readyState = 0;
    private l: Record<string, Array<(e?: any) => void>> = {};
    constructor(url: string) {
      opened.push(url);
      setTimeout(() => { this.readyState = 1; (this.l.open || []).forEach((f) => f()); }, 0);
    }
    addEventListener(t: string, f: (e?: any) => void) { (this.l[t] ||= []).push(f); }
    send(d: string) { frames.push(d); }
    close() { this.readyState = 3; }
  };
  return { opened, frames };
}

test("the relay never sends the account token to another account's relay port", async () => {
  const realWS = (globalThis as any).WebSocket;
  try {
    const { opened, frames } = fakeWS();
    const errors: string[] = [];
    const c = new RelayClient({ url: 'wss://127.0.0.1:8205/ws/chat', token: 'acct-tok', nick: 'me',
      handlers: { onError: (m) => errors.push(m) }, guardEnv: linux(table([[V4_LO, 8205, OTHER]])) });
    c.connect('#general');
    await new Promise((r) => setTimeout(r, 20));
    c.disconnect();
    assert.equal(opened.length, 0, 'no socket opened to the squatter');
    assert.ok(!frames.some((f) => f.includes('acct-tok')));
    assert.match(errors[0] ?? '', /refused to send credentials.*uid 1001/);
  } finally { (globalThis as any).WebSocket = realWS; }
});

test("the relay joins with the token on our own (or root's) relay port", async () => {
  const realWS = (globalThis as any).WebSocket;
  try {
    const { opened, frames } = fakeWS();
    const c = new RelayClient({ url: 'wss://127.0.0.1:8205/ws/chat', token: 'acct-tok', nick: 'me',
      handlers: {}, guardEnv: linux(table([[V4_LO, 8205, 0]])) });
    c.connect('#general');
    await new Promise((r) => setTimeout(r, 20));
    c.disconnect();
    assert.equal(opened.length, 1);
    assert.ok(frames.some((f) => JSON.parse(f).token === 'acct-tok'));
  } finally { (globalThis as any).WebSocket = realWS; }
});

test("a foreign listener on this machine's LAN IP is refused", async () => {
  const net = table([[LAN_HEX, 10001, OTHER]]);
  const { sent, inner } = recorder();
  await assert.rejects(guardFetch(inner, linux(net))(`http://${LAN_IP}:10001/chat`, { headers: BEARER }),
    /192\.168\.1\.50 port 10001 is held by uid 1001/);
  assert.equal(sent.length, 0);
});

test('a foreign wildcard listener is refused when the target is the LAN IP', async () => {
  for (const net of [table([[V4_ANY, 10001, OTHER]]), table([], [[V6_ANY, 10001, OTHER]])]) {
    assert.match((await credentialTargetProblem(`http://${LAN_IP}:10001`, linux(net))) ?? '', /uid 1001/);
  }
});

test('our own listener on the LAN IP (exact or wildcard) is allowed', async () => {
  for (const net of [table([[LAN_HEX, 10001, ME]]), table([[V4_ANY, 10001, ME]])]) {
    const { sent, inner } = recorder();
    await guardFetch(inner, linux(net))(`http://${LAN_IP}:10001/chat`, { headers: BEARER });
    assert.equal(sent.length, 1);
  }
});

test("the machine's hostname (and names resolving to its NICs) is local", async () => {
  const net = table([[V4_ANY, 10001, OTHER]]);
  for (const url of ['http://desk:10001', 'http://DESK.:10001', 'http://desk.lan:10001',
    'http://[::ffff:192.168.1.50]:10001']) {
    assert.match((await credentialTargetProblem(url, linux(net))) ?? '', /uid 1001/, url);
  }
  // Our own name that does not resolve: we cannot tell where it goes -> refuse.
  assert.match((await credentialTargetProblem('http://desk:10001', {
    ...linux(net), lookup: async () => { throw new Error('ENOTFOUND'); } })) ?? '',
  /cannot resolve this machine's own name/);
});

test('a remote host is untouched, resolvable or not', async () => {
  const net = table([[V4_ANY, 443, OTHER], [V4_ANY, 10001, OTHER]]);
  const { sent, inner } = recorder();
  const f = guardFetch(inner, linux(net));
  await f('https://gateway.aitherium.com/v1/models', { headers: BEARER });
  await f('http://nas.example.test:10001/x', { headers: BEARER });     // ENOTFOUND, not our name
  await f('http://192.168.1.99:10001/x', { headers: BEARER });          // a LAN peer, not us
  assert.equal(sent.length, 3);
});

test('a global IPv6 NIC address matches its /proc/net row', async () => {
  const FD00_50 = '000000FD' + '00000000' + '00000000' + '50000000';
  assert.equal(canonicalAddr('FD00::50%eth0'), 'fd00:0:0:0:0:0:0:50');
  assert.equal(canonicalAddr('::ffff:192.168.1.50'), LAN_IP);
  const net = table([], [[FD00_50, 10001, OTHER]]);
  assert.match((await credentialTargetProblem('http://[fd00::50]:10001', linux(net))) ?? '', /uid 1001/);
});
