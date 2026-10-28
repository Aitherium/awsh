/**
 * Relay DMs and one-shot channel read/send from the shell. Pinned: the REST calls hit the
 * relay's own routes with the session's bearer (GET /v1/dms/partners, GET /v1/dms/{nick},
 * POST /v1/dms, GET|POST /v1/channels/{ch}/messages); a refusal comes back in the relay's
 * words; off a fleet host a signed-in session moves to the hosted relay (never when
 * AITHER_RELAY_URL names one); and the verbs refuse to send without a sign-in.
 */
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTED_RELAY_URL, LOCAL_RELAY_URL, RelayClient, relayErrorText, channelSegment } from '../src/relay.js';
import {
  isRelayOneShot, runDmCommand, runRelayCommand, type RelayRest,
} from '../src/relay-command.js';

const realFetch = globalThis.fetch;
const realEnv = process.env.AITHER_RELAY_URL;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnv === undefined) delete process.env.AITHER_RELAY_URL; else process.env.AITHER_RELAY_URL = realEnv;
});

const LOCAL_HTTP = 'https://127.0.0.1:8205';
const HOSTED_HTTP = 'https://relay.aitherium.com';

type Seen = { method: string; url: string; auth?: string; body?: any };
function fakeFetch(answer: (s: Seen) => Response | 'refuse') {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const h = (init?.headers || {}) as Record<string, string>;
    const s: Seen = {
      method: init?.method || 'GET', url: String(url), auth: h.Authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    const a = answer(s);
    if (a === 'refuse') throw new TypeError('fetch failed (ECONNREFUSED)');
    return a;
  }) as typeof fetch;
  return seen;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const client = (token?: string) =>
  new RelayClient({ url: LOCAL_RELAY_URL, token, nick: 'me', handlers: {} });

describe('RelayClient REST', () => {
  test('DM partners, history and send hit the relay routes with the bearer', async () => {
    delete process.env.AITHER_RELAY_URL;
    const seen = fakeFetch((s) => {
      if (s.url.endsWith('/v1/dms/partners')) return json({ partners: [{ nick: 'bob', online: true, last_message: null }] });
      if (s.method === 'GET') return json({ messages: [
        { from_nick: 'bob', to_nick: 'me', content: 'second', timestamp: '2026-10-28T10:02:00Z' },
        { from_nick: 'me', to_nick: 'bob', content: 'first', timestamp: '2026-10-28T10:01:00Z' },
      ] });
      return json({ success: true, message: { from_nick: 'me', to_nick: 'bob', content: 'hi' }, delivered: true });
    });
    const c = client('tok');
    const p = await c.dmPartners();
    assert.ok(p.ok && p.data[0].nick === 'bob');
    const h = await c.dmHistory('@bob smith');
    assert.ok(h.ok);
    assert.deepEqual(h.ok && h.data.map((m) => m.content), ['first', 'second']);
    const s = await c.sendDm('@bob', 'hi');
    assert.ok(s.ok && s.data.delivered);
    assert.deepEqual(seen.map((x) => `${x.method} ${x.url}`), [
      `GET ${LOCAL_HTTP}/v1/dms/partners`,
      `GET ${LOCAL_HTTP}/v1/dms/bob%20smith?limit=30`,
      `POST ${LOCAL_HTTP}/v1/dms`,
    ]);
    assert.ok(seen.every((x) => x.auth === 'Bearer tok'));
    assert.deepEqual(seen[2].body, { to_nick: 'bob', content: 'hi' });
  });

  test('channel read and post: "#" never reaches the path, the post carries the nick', async () => {
    delete process.env.AITHER_RELAY_URL;
    const seen = fakeFetch((s) => (s.method === 'GET'
      ? json({ messages: [{ channel: '#ops', nick: 'a', content: 'x', timestamp: '1' }] })
      : json({ success: true, message: { channel: '#ops', nick: 'me', content: 'hello' } })));
    const c = client('tok');
    const r = await c.read('#ops', 5);
    assert.ok(r.ok && r.data.length === 1);
    const p = await c.post('ops', 'hello');
    assert.ok(p.ok);
    assert.equal(seen[0].url, `${LOCAL_HTTP}/v1/channels/ops/messages?limit=5`);
    assert.equal(seen[1].url, `${LOCAL_HTTP}/v1/channels/ops/messages`);
    assert.deepEqual(seen[1].body, { channel: '#ops', nick: 'me', content: 'hello', agent: false });
    assert.equal(channelSegment('#a b'), 'a%20b');
  });

  test("a refusal comes back in the relay's words; a held message is a refusal", async () => {
    delete process.env.AITHER_RELAY_URL;
    fakeFetch((s) => (s.url.endsWith('/v1/dms')
      ? json({ success: false, held: true, message: 'Held for a grown-up to read first.' })
      : json({ detail: 'External agents can only DM other agents, not humans.' }, 403)));
    const c = client('tok');
    const h = await c.dmHistory('bob');
    assert.deepEqual(h, { ok: false, status: 403, error: 'External agents can only DM other agents, not humans.' });
    const s = await c.sendDm('bob', 'hi');
    assert.deepEqual(s, { ok: false, error: 'Held for a grown-up to read first.' });
    assert.match(relayErrorText(401, { detail: 'DM requires authentication' }), /awsh login/);
    assert.equal(relayErrorText(422, { detail: [{ msg: 'field required' }] }), 'field required');
    assert.equal(relayErrorText(500, null), 'HTTP 500');
  });

  test('off a fleet host: signed in moves to the hosted relay; anonymous or an override does not', async () => {
    delete process.env.AITHER_RELAY_URL;
    let seen = fakeFetch((s) => (s.url.startsWith(LOCAL_HTTP) ? 'refuse' : json({ partners: [] })));
    const r = await client('tok').dmPartners();
    assert.ok(r.ok);
    assert.deepEqual(seen.map((x) => x.url), [`${LOCAL_HTTP}/v1/dms/partners`, `${HOSTED_HTTP}/v1/dms/partners`]);
    assert.equal(HOSTED_RELAY_URL.replace(/^wss/, 'https').replace(/\/ws\/chat$/, ''), HOSTED_HTTP);

    seen = fakeFetch(() => 'refuse');
    const anon = await client().read('#general');
    assert.equal(anon.ok, false);
    assert.equal(seen.length, 1, 'anonymous stays local');

    process.env.AITHER_RELAY_URL = LOCAL_RELAY_URL;
    seen = fakeFetch(() => 'refuse');
    const pinned = await client('tok').dmPartners();
    assert.equal(pinned.ok, false);
    assert.equal(seen.length, 1, 'an explicit relay is never swapped for hosted');
  });
});

/** A RelayRest fake that records calls and answers ok. */
function fakeRelay(over: Partial<RelayRest> = {}) {
  const calls: string[] = [];
  const rec = (name: string, ...a: unknown[]) => {
    calls.push(`${name}(${a.map((x) => (x === undefined ? 'undefined' : JSON.stringify(x))).join(',')})`);
  };
  const relay: RelayRest = {
    async channels(scope) { rec('channels', scope); return { ok: true, data: [{ name: '#general', topic: 'hi' }] }; },
    async read(ch, n) { rec('read', ch, n); return { ok: true, data: [{ channel: ch, nick: 'a', content: 'x' }] }; },
    async post(ch, t) { rec('post', ch, t); return { ok: true, data: null }; },
    async dmPartners() { rec('dmPartners'); return { ok: true, data: [{ nick: 'bob', online: true, last_message: { from_nick: 'bob', to_nick: 'me', content: 'yo' } }] }; },
    async dmHistory(n, l) { rec('dmHistory', n, l); return { ok: true, data: [{ from_nick: 'bob', to_nick: 'me', content: 'yo' }] }; },
    async sendDm(n, t) { rec('sendDm', n, t); return { ok: true, data: { delivered: false, message: null } }; },
    ...over,
  };
  return { relay, calls };
}

describe('/relay and /dm verbs', () => {
  test('/dm lists, reads and sends; nothing without a sign-in', async () => {
    const { relay, calls } = fakeRelay();
    const out: string[] = [];
    const d = { relay, signedIn: true, out: (l: string) => out.push(l) };
    assert.deepEqual(await runDmCommand([], d), { ok: true });
    assert.deepEqual(await runDmCommand(['@bob'], d), { ok: true });
    assert.deepEqual(await runDmCommand(['bob', 'hi', 'there'], d), { ok: true });
    assert.deepEqual(calls, ['dmPartners()', 'dmHistory("bob",undefined)', 'sendDm("bob","hi there")']);
    assert.ok(out.some((l) => l.includes('bob') && l.includes('yo')));
    assert.ok(out.some((l) => l.includes('saved; they see it when they are back')));

    const anon = fakeRelay();
    const r = await runDmCommand(['bob', 'hi'], { relay: anon.relay, signedIn: false, out: () => {} });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : '', /awsh login/);
    assert.deepEqual(anon.calls, []);
  });

  test('/relay read|send|channels|#ch, and a refusal surfaces as "relay: <words>"', async () => {
    const { relay, calls } = fakeRelay();
    const d = { relay, signedIn: true, out: () => {} };
    await runRelayCommand(['read', 'ops', '5'], d);
    await runRelayCommand(['#ops'], d);
    await runRelayCommand(['send', '#ops', 'hello', 'all'], d);
    await runRelayCommand(['channels', 'community'], d);
    await runRelayCommand(['dm', 'bob', 'yo'], d);
    assert.deepEqual(calls, ['read("#ops",5)', 'read("#ops",20)', 'post("#ops","hello all")',
      'channels("community")', 'sendDm("bob","yo")']);

    assert.equal((await runRelayCommand(['send', '#ops'], d)).ok, false, 'no text is a usage error');
    const anon = fakeRelay();
    const s = await runRelayCommand(['send', '#ops', 'hi'], { relay: anon.relay, signedIn: false, out: () => {} });
    assert.equal(s.ok, false);
    assert.deepEqual(anon.calls, [], 'never posts without a sign-in');
    assert.equal((await runRelayCommand(['read', '#ops'], { relay: anon.relay, signedIn: false, out: () => {} })).ok,
      true, 'reading is open');

    const refused = fakeRelay({ async read() { return { ok: false, status: 404, error: 'Channel #nope not found' }; } });
    assert.deepEqual(await runRelayCommand(['read', '#nope'], { relay: refused.relay, signedIn: true, out: () => {} }),
      { ok: false, error: 'relay: Channel #nope not found' });
  });

  test('which /relay forms run once (the rest join live chat)', () => {
    assert.equal(isRelayOneShot('read #ops'), true);
    assert.equal(isRelayOneShot('send #ops hi'), true);
    assert.equal(isRelayOneShot('dm bob'), true);
    assert.equal(isRelayOneShot('channels'), true);
    assert.equal(isRelayOneShot('channels', true), false, 'live chat lists its own channels');
    assert.equal(isRelayOneShot('#ops'), false);
    assert.equal(isRelayOneShot(''), false);
    assert.equal(isRelayOneShot('join #ops'), false);
  });
});

test('/relay and /dm are registered; a refusal raises (one-shot exits 1)', async () => {
  const { getCommand } = await import('../src/commands.js');
  const dm = getCommand('dm');
  const relay = getCommand('relay');
  assert.ok(dm && relay);
  const cfg = { authToken: null, authUser: null } as any;
  await assert.rejects(dm!.handler(null as any, 'bob hi', cfg), /sign in first/);
  await assert.rejects(relay!.handler(null as any, 'send #ops hi', cfg), /sign in first/);
});
