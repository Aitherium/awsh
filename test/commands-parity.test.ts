/**
 * commands.ts / command-registry.ts parity.
 *
 * Pins three gaps that were live on develop:
 *   1. commands.json aliases (b, lb, mon, nb, prod, ...) did not resolve through
 *      getCommand(), so typing them printed "Unknown command".
 *   2. Genesis catalog entries carrying `genesis_endpoint` (the @shell_command
 *      routes, e.g. /shell/ctl/temp) were listed in the picker but never
 *      executable: the registry stored genesisEndpoint and nothing read it.
 *   3. /command (alias /do) — the desk Command agent — had a client
 *      (deskCommand) and no slash command.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { getCommand, getCommandNames, runDeskCommand } = await import('../src/commands.js');
const { CommandRegistry } = await import('../src/command-registry.js');
const { resolveFallback, runFallback, parseToolParams, formatFallbackOutput } =
  await import('../src/command-fallback.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('every commands.json name AND alias resolves through getCommand', () => {
  const data = JSON.parse(readFileSync(join(here, '..', 'commands.json'), 'utf-8'));
  const missing: string[] = [];
  for (const c of data.commands) {
    if (!getCommand(c.name)) missing.push(c.name);
    for (const a of c.aliases || []) {
      if (!getCommand(a)) missing.push(`${a} (alias of ${c.name})`);
      // An alias that is ALSO a built-in command name (e.g. `scope`) keeps the
      // built-in; every other alias must reach its canonical handler.
      else if (!getCommandNames().includes(a)) {
        assert.equal(getCommand(a), getCommand(c.name), `alias ${a} must reach ${c.name}'s handler`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('getCommand does not invent commands', () => {
  assert.equal(getCommand('definitely-not-a-command-xyz'), undefined);
  assert.equal(getCommand('constructor'), undefined);
});

test('/command and its alias /do are the desk Command agent', () => {
  const cmd = getCommand('command');
  assert.ok(cmd, '/command must exist');
  assert.equal(getCommand('do'), cmd);
});

test('runDeskCommand posts the text and prints the reply from history', async () => {
  const seen: Array<{ method: string; url: string; body?: any }> = [];
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const method = init?.method || 'GET';
    seen.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'POST') return new Response(JSON.stringify({ id: 'cmd-9' }), { status: 202 });
    return new Response(JSON.stringify({ items: [
      { id: 'other', at: 't', source: 's', text: 'x', reply: 'not mine' },
      { id: 'cmd-9', at: 't', source: 'awsh', text: 'open notes', reply: 'opened notes' },
    ] }), { status: 200 });
  }) as typeof fetch;
  const lines: string[] = [];
  const res = await runDeskCommand('open notes', { waitMs: 0, pollMs: 1, log: (l) => lines.push(l) });
  assert.equal(res.id, 'cmd-9');
  assert.equal(res.reply, 'opened notes');
  assert.equal(seen[0].method, 'POST');
  assert.ok(seen[0].url.endsWith('/command'));
  assert.deepEqual(seen[0].body, { text: 'open notes' });
  assert.ok(seen[1].url.includes('/command/history'));
  assert.ok(lines.some((l) => l.includes('opened notes')));
});

test('runDeskCommand gives up after the wait and says so', async () => {
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    if ((init?.method || 'GET') === 'POST') return new Response(JSON.stringify({ id: 'c1' }), { status: 200 });
    return new Response(JSON.stringify({ items: [{ id: 'c1', at: 't', source: 's', text: 'x' }] }), { status: 200 });
  }) as typeof fetch;
  const lines: string[] = [];
  const res = await runDeskCommand('x', { waitMs: 0, pollMs: 1, log: (l) => lines.push(l) });
  assert.equal(res.reply, undefined);
  assert.ok(lines.some((l) => l.includes('no reply yet')));
});

// ── Genesis catalog fallback ────────────────────────────────────────────

function fakeClient(catalog: any[], mcp: any[] = [], post?: (p: string, b: any) => any) {
  const calls: Array<{ verb: string; path: string; body?: any }> = [];
  const client: any = {
    async get(path: string) {
      if (path === '/shell/commands') return { commands: catalog };
      if (path === '/shell/commands/mcp') return { commands: mcp };
      return null;
    },
    async postDetailed(path: string, body: any) {
      calls.push({ verb: 'POST', path, body });
      return post ? post(path, body) : { ok: true, message: `done ${body.value}` };
    },
    async getDetailed(path: string) {
      calls.push({ verb: 'GET', path });
      return { ok: true, verbs: ['a'] };
    },
  };
  return { client, calls };
}

test('a Genesis @shell_command entry is executable via its genesis_endpoint', async () => {
  const reg = new CommandRegistry();
  const { client, calls } = fakeClient([
    { name: 'temp', category: 'control', description: 't', aliases: ['temperature'], source: 'genesis',
      genesis_endpoint: '/shell/ctl/temp' },
  ]);
  await reg.loadDynamicCommands(client);
  assert.equal(getCommand('temp'), undefined, 'precondition: no built-in handler');

  const fb = resolveFallback(reg, 'temperature');
  assert.deepEqual(fb, { kind: 'genesis', name: 'temp', endpoint: '/shell/ctl/temp' });

  const res = await runFallback(client, fb!, '0.4', { sessionId: 'sess-1' });
  assert.equal(res.ok, true);
  assert.equal(calls[0].path, '/shell/ctl/temp');
  assert.equal(calls[0].body.session_id, 'sess-1');
  assert.equal(calls[0].body.value, '0.4');
  assert.equal(formatFallbackOutput(res.output), 'done 0.4');
});

test('a Genesis route refusing POST (405) is retried as GET', async () => {
  const reg = new CommandRegistry();
  const { client, calls } = fakeClient(
    [{ name: 'verbs', source: 'genesis', genesis_endpoint: '/ctl/verbs' }],
    [],
    () => ({ error: 'Method Not Allowed', status: 405 }),
  );
  await reg.loadDynamicCommands(client);
  const res = await runFallback(client, resolveFallback(reg, 'verbs')!, '', { sessionId: 's' });
  assert.equal(res.ok, true);
  assert.deepEqual(calls.map((c) => c.verb), ['POST', 'GET']);
});

test('a Genesis error and an ok:false body are surfaced, not printed as success', async () => {
  const reg = new CommandRegistry();
  const { client } = fakeClient(
    [{ name: 'reason', source: 'genesis', genesis_endpoint: '/shell/ctl/reason' }],
    [],
    () => ({ ok: false, message: 'usage: /reason on|off' }),
  );
  await reg.loadDynamicCommands(client);
  const res = await runFallback(client, resolveFallback(reg, 'reason')!, 'maybe', { sessionId: 's' });
  assert.equal(res.ok, false);
  assert.match(res.error!, /usage: \/reason/);
});

test('templated endpoints are refused instead of POSTing a literal {id}', async () => {
  const reg = new CommandRegistry();
  const { client, calls } = fakeClient([{ name: 'run', source: 'genesis', genesis_endpoint: '/runs/{id}' }]);
  await reg.loadDynamicCommands(client);
  const res = await runFallback(client, resolveFallback(reg, 'run')!, '', { sessionId: 's' });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});

test('mcp:<tool> catalog entries and discovered MCP tools resolve to the MCP transport', async () => {
  const reg = new CommandRegistry();
  const { client } = fakeClient(
    [{ name: 'mcp:web_search', source: 'mcp', genesis_endpoint: '/tools/call' }],
    [{ name: 'recall', source: 'mcp', genesis_endpoint: '/tools/call' }],
  );
  await reg.loadDynamicCommands(client);
  assert.deepEqual(resolveFallback(reg, 'mcp:web_search'), { kind: 'mcp', name: 'mcp:web_search', tool: 'web_search' });
  assert.deepEqual(resolveFallback(reg, 'recall'), { kind: 'mcp', name: 'recall', tool: 'recall' });
  assert.equal(resolveFallback(reg, 'nope-nothing'), null);
});

test('parseToolParams: JSON, key=value, bare words', () => {
  assert.deepEqual(parseToolParams('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolParams('a=1 b=two'), { a: '1', b: 'two' });
  assert.deepEqual(parseToolParams('hello world'), { input: 'hello world' });
  assert.deepEqual(parseToolParams(''), {});
});

test('both REPLs route unknown commands through the shared fallback', () => {
  for (const rel of ['../src/repl.ts', '../src/tui/repl-tui.ts']) {
    const src = readFileSync(join(here, rel), 'utf-8');
    assert.match(src, /resolveFallback\(registry,/, `${rel} must use the catalog fallback`);
    assert.match(src, /runFallback\(client,/, `${rel} must execute the fallback`);
  }
});
