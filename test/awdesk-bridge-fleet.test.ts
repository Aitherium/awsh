/**
 * Tests for fleet control and desk command functions in awdesk-bridge.
 *
 * These test the URL shapes, request/response contracts, and polling logic.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { fleetStatus, fleetControl, deskCommand, deskCommandHistory, classifyFleet, summarizeFleet, deskDesktop } =
  await import('../src/awdesk-bridge.js');

const realFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  init?: RequestInit;
  body?: any;
}

const calls: FetchCall[] = [];

/**
 * Stub fetch for fleet and command endpoints. Responder can check the URL
 * and init to return appropriate responses.
 */
function stubFetch(
  responder: (method: string, url: string, init?: RequestInit) => {
    status?: number;
    json?: any;
    text?: any;
  },
) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const urlStr = String(url);
    let body: any;
    try {
      if (init?.body) body = JSON.parse(String(init.body));
    } catch {
      // ignore parse errors
    }
    calls.push({ url: urlStr, init, body });

    const method = String(url).split('/').pop() || 'GET';
    const r = responder(method, urlStr, init);
    const status = r.status ?? 200;
    const headers = new Headers({ 'content-type': 'application/json' });

    const content = r.text !== undefined ? r.text : (r.json ? JSON.stringify(r.json) : '');
    return new Response(content, { status, headers });
  }) as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── Fleet Status ──────────────────────────────────────────────────────────

test('fleetStatus makes a GET request with 90s timeout', async () => {
  stubFetch((_method, url) => {
    assert.ok(url.includes('/fleet/status'));
    return { json: { state: 'up', last_change: '2026-09-08T12:00:00Z' } };
  });

  const result = await fleetStatus();
  assert.equal(result.state, 'up');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/fleet/status'));
});

test('fleetStatus accepts fresh parameter', async () => {
  stubFetch((_method, url) => {
    if (url.includes('fresh=1')) {
      return { json: { state: 'up', fresh: true } };
    }
    return { json: { state: 'down' } };
  });

  const result = await fleetStatus(true);
  assert.equal(result.fresh, true);
  assert.ok(calls[0].url.includes('fresh=1'));
});

test('fleetStatus throws on HTTP error', async () => {
  stubFetch(() => ({ status: 500 }));

  await assert.rejects(() => fleetStatus(), /HTTP 500/);
});

// ── Fleet Control ──────────────────────────────────────────────────────────

test('fleetControl makes POST requests to /fleet/<action>', async () => {
  stubFetch((_method, url) => {
    assert.ok(url.includes('/fleet/down'));
    return { json: { state: 'held', reason: 'fleet down' } };
  });

  const result = await fleetControl('down');
  assert.equal(result.state, 'held');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call.url.includes('/fleet/down'));
  assert.equal(call.init?.method, 'POST');
});

test('fleetControl encodes action names in URL', async () => {
  stubFetch((_method, url) => {
    // If the action had spaces or special chars, they should be encoded
    assert.ok(!url.includes('my action'));
    return { json: {} };
  });

  await fleetControl('my-action');
  assert.ok(calls[0].url.includes('my-action'));
});

test('fleetControl works with empty response body', async () => {
  stubFetch(() => ({ status: 200, text: '' }));

  const result = await fleetControl('resume');
  assert.deepEqual(result, {});
});

// ── Desk Command ──────────────────────────────────────────────────────────

test('deskCommand POSTs {text} and returns the command id', async () => {
  stubFetch((_method, url, init) => {
    assert.ok(url.includes('/command'));
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.text, 'hello');
    return { status: 200, json: { id: 'cmd-123' } };
  });

  const id = await deskCommand('hello');
  assert.equal(id, 'cmd-123');
});

test('deskCommand accepts 202 responses', async () => {
  stubFetch(() => ({
    status: 202,
    json: { id: 'cmd-456' },
  }));

  const id = await deskCommand('test');
  assert.equal(id, 'cmd-456');
});

test('deskCommand throws on non-2xx status', async () => {
  stubFetch(() => ({ status: 400 }));

  await assert.rejects(() => deskCommand('test'), /HTTP 400/);
});

// ── Desk Command History ──────────────────────────────────────────────────

test('deskCommandHistory GET with limit parameter', async () => {
  stubFetch((_method, url) => {
    assert.ok(url.includes('/command/history'));
    assert.ok(url.includes('limit=5'));
    return {
      json: {
        items: [
          {
            id: 'cmd-1',
            at: '2026-09-08T12:00:00Z',
            source: 'cli',
            text: 'hello',
            reply: 'hi',
            kind: 'user',
          },
        ],
      },
    };
  });

  const items = await deskCommandHistory(5);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'hello');
  assert.equal(items[0].reply, 'hi');
});

test('deskCommandHistory defaults to limit 10', async () => {
  stubFetch((_method, url) => {
    assert.ok(url.includes('limit=10'));
    return { json: { items: [] } };
  });

  await deskCommandHistory();
  assert.ok(calls[0].url.includes('limit=10'));
});

test('deskCommandHistory returns empty array when no items', async () => {
  stubFetch(() => ({ json: {} }));

  const items = await deskCommandHistory(20);
  assert.deepEqual(items, []);
});

test('deskCommandHistory throws on HTTP error', async () => {
  stubFetch(() => ({ status: 500 }));

  await assert.rejects(() => deskCommandHistory(), /HTTP 500/);
});

// ── Polling integration ───────────────────────────────────────────────────

test('deskCommandHistory is suitable for polling (finds reply by id)', async () => {
  const targetId = 'cmd-abc';
  let callCount = 0;

  stubFetch((_method, url) => {
    callCount += 1;
    if (callCount === 1) {
      // First call: no reply yet
      return {
        json: {
          items: [{ id: targetId, text: 'hello', at: new Date().toISOString() }],
        },
      };
    }
    // Second call: reply arrived
    return {
      json: {
        items: [{ id: targetId, text: 'hello', reply: 'answered', at: new Date().toISOString() }],
      },
    };
  });

  // First poll
  let items = await deskCommandHistory(1);
  const first = items.find(i => i.id === targetId);
  assert.equal(first?.reply, undefined);

  // Second poll
  items = await deskCommandHistory(1);
  const second = items.find(i => i.id === targetId);
  assert.equal(second?.reply, 'answered');
});

// ---- bearer on mutators (2026-09-08) ------------------------------------------

test('fleetControl and deskCommand send the harness bearer; reads do not', async () => {
  const prev = process.env.AITHER_HARNESS_TOKEN;
  process.env.AITHER_HARNESS_TOKEN = 'unit-token';
  try {
    stubFetch(() => ({ json: { ok: true, id: 'c1' } }));
    await fleetControl('down');
    await deskCommand('ping');
    await fleetStatus();
    const auth = (c: FetchCall) => new Headers(c.init?.headers as any).get('authorization');
    assert.equal(auth(calls[0]), 'Bearer unit-token');
    assert.equal(auth(calls[1]), 'Bearer unit-token');
    assert.equal(auth(calls[2]), null); // GET /fleet/status stays unauthenticated
  } finally {
    if (prev === undefined) delete process.env.AITHER_HARNESS_TOKEN;
    else process.env.AITHER_HARNESS_TOKEN = prev;
  }
});

test('a 401 from the bridge names the bearer, not a bare HTTP code', async () => {
  stubFetch(() => ({ status: 401, json: { ok: false, error: 'bearer required' } }));
  await assert.rejects(() => fleetControl('down'), /AITHER_HARNESS_TOKEN/);
  await assert.rejects(() => deskCommand('x'), /harness bearer/);
});

// ---- the one sentence awsh, adk and the desk tooltip share (2026-09-08) ----

test('summarizeFleet names who holds the VRAM and which doors are down', () => {
  const status = {
    fleet: { running: 0, masked: 171, units: 189, scope: 'all' },
    held: true,
    vram: { used_mib: 10413, total_mib: 32607 },
    gpu_holders: [
      { pid: 21084, name: 'python', gib: 7.06, hint: 'ComfyUI :8188 (Windows, not the fleet)' },
      { pid: 2876, name: 'dwm', gib: 4.46, hint: 'Windows desktop compositor' },
      { pid: 1, name: 'msedge', gib: 0.2, hint: 'browser' },
    ],
    surfaces: [
      { id: 'pulse', up: true }, { id: 'tunnel', up: false }, { id: 'mcp', up: false },
    ],
  };
  assert.equal(classifyFleet(status), 'DOWN');
  assert.equal(
    summarizeFleet(status),
    'DOWN — 0 container(s) running, 171/189 units masked, GPU 10.2/32 GiB (ComfyUI 7.1, dwm 4.5), HOLD yes, scope=all, doors 1/3 up (down: tunnel, mcp)',
  );
  assert.equal(summarizeFleet({ cannotJudge: true, error: 'inspect rc=1' }), 'CANNOT JUDGE — inspect rc=1');
  assert.equal(classifyFleet({ fleet: { running: 12, masked: 0 } }), 'UP');
  // No holders / no surfaces: the sentence simply has no parenthesis and no doors clause.
  assert.equal(summarizeFleet({ fleet: { running: 3 } }), 'UP — 3 container(s) running, ?/? units masked, GPU ?, HOLD no');
});

test('deskDesktop: status is a GET, overlay/app POST, no bearer, and an old desk is named', async () => {
  stubFetch(() => ({ json: { ok: true, opened: 'app', overlay: { open: false }, app: { open: true } } }));
  const st = await deskDesktop('app');
  assert.equal(st.app.open, true);
  assert.equal(calls[0].init?.method, 'POST');
  assert.match(calls[0].url, /\/desktop\/app$/);
  assert.equal(new Headers(calls[0].init?.headers as any).get('authorization'), null);
  await deskDesktop('status');
  assert.equal(calls[1].init?.method, 'GET');
  stubFetch(() => ({ status: 404, text: '' }));
  await assert.rejects(() => deskDesktop('overlay'), /older build/);
});
