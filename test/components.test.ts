/**
 * components.ts: the daemon is the loader; only loopback http opens; a capability
 * opens on its host; a component with nothing the shell can do is not a pack.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import {
  componentToPack, componentUrl, discoverComponentPacks, fetchComponents,
  findComponentPack, isOpenableUrl, type LocalComponent,
} from '../src/components.js';
import { isUsable } from '../src/packs.js';

const comp = (over: Partial<LocalComponent>): LocalComponent => ({
  id: 'awgym', brick: 'awgym', name: 'awgym', type: 'process', status: 'running',
  endpoint: 'http://127.0.0.1:8190', health_ok: true,
  surfaces: { ui: { path: '/', title: 'awgym' }, commands: [{ name: 'play', run: 'awgym play' }] },
  ...over,
});

const fakeFetch = (body: unknown, ok = true) => (async () =>
  ({ ok, json: async () => body })) as unknown as typeof fetch;

describe('isOpenableUrl / componentUrl', () => {
  test('plain-http loopback only', () => {
    assert.equal(isOpenableUrl('http://127.0.0.1:8190'), true);
    assert.equal(isOpenableUrl('https://127.0.0.1:8490'), false);
    assert.equal(isOpenableUrl('http://localhost:8190'), false);
    assert.equal(isOpenableUrl('http://10.0.0.5:8190'), false);
  });
  test('capability opens on the host, never on itself', () => {
    const cap = comp({ id: 'awrun', type: 'capability', endpoint: '',
      surfaces: { ui: { path: '/api/local/awrun', title: 'Runs' } } });
    assert.equal(componentUrl(cap, 'http://127.0.0.1:9001'), 'http://127.0.0.1:9001/api/local/awrun');
    assert.equal(componentUrl(comp({ surfaces: {} }), 'http://127.0.0.1:9001'), null);
    assert.equal(componentUrl(comp({ endpoint: 'http://10.1.1.1:1' }), 'http://127.0.0.1:9001'), null);
  });
});

describe('componentToPack', () => {
  const online = { state: 'online' as const, base: 'http://127.0.0.1:9001', port: 9001, components: [] };
  test('commands and appUrl carry over; no systemPrompt so it is not a brain', () => {
    const p = componentToPack(comp({}), online)!;
    assert.equal(p.name, 'awgym');
    assert.equal(p.appUrl, 'http://127.0.0.1:8190/');
    assert.deepEqual(p.commands, [{ name: 'play', description: undefined, run: 'awgym play', url: undefined }]);
    assert.equal(p.appScript, undefined);
    assert.equal(isUsable(p), false, 'a component must not enter the shell as a brain');
  });
  test('a command with no action is refused; a component with nothing to do is not a pack', () => {
    const p = componentToPack(comp({ surfaces: { commands: [{ name: 'noop' }] } }), online);
    assert.equal(p, null);
    const q = componentToPack(comp({ surfaces: { mcp: { path: '/mcp' } } }), online);
    assert.equal(q, null);
  });
});

describe('fetchComponents / discoverComponentPacks', () => {
  test('offline names the base and lists nothing', async () => {
    const r = await fetchComponents('http://127.0.0.1:1', (async () => { throw new Error('refused'); }) as unknown as typeof fetch);
    assert.equal(r.state, 'offline');
    assert.equal(r.base, 'http://127.0.0.1:1');
  });
  test('an older daemon that answers HTML at every path is "unsupported", not offline', async () => {
    const html = (async () => ({ ok: true, json: async () => { throw new SyntaxError('not JSON'); } })) as unknown as typeof fetch;
    const r = await fetchComponents('http://127.0.0.1:9001', html);
    assert.equal(r.state, 'unsupported');
    const noList = await fetchComponents('http://127.0.0.1:9001', fakeFetch({ status: 'healthy' }));
    assert.equal(noList.state, 'unsupported');
    // 404 on /components while /health is 200: running, old -- the measured shape of
    // the resident site-packages daemon on 2026-09-06.
    const old404 = (async (url: string) => ({ ok: !String(url).endsWith('/components'),
      json: async () => ({ status: 'healthy' }) })) as unknown as typeof fetch;
    assert.equal((await fetchComponents('http://127.0.0.1:9001', old404)).state, 'unsupported');
  });
  test('online normalises the daemon shape and resolves a capability on the daemon port', async () => {
    const f = fakeFetch({ port: 9002, components: [
      { id: 'awrun', brick: 'awrun', type: 'capability', hosted_by: 'awdk', surfaces: { ui: { path: '/api/local/awrun' } } },
      { id: 'awnode', type: 'process', endpoint: 'http://127.0.0.1:8182', surfaces: { mcp: { path: '/mcp' } } },
      { nope: true },
    ] });
    const { result, packs } = await discoverComponentPacks('http://127.0.0.1:9002', f);
    assert.equal(result.state, 'online');
    assert.deepEqual(packs.map(p => p.name), ['awrun']);
    assert.equal(packs[0].appUrl, 'http://127.0.0.1:9002/api/local/awrun');
    assert.equal((await findComponentPack('AWRUN', 'http://127.0.0.1:9002', f))?.name, 'awrun');
    assert.equal(await findComponentPack('awnode', 'http://127.0.0.1:9002', f), undefined);
  });
});
