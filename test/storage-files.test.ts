/**
 * `/storage find|dupes|tree|share|shares` — the disk-index surface of awsh.
 *
 * Genesis is mocked: a fake GenesisClient records the exact path/body each
 * subcommand sends, so these tests pin the wire contract
 * (the disk index contract) without a live fleet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStorageCommand, fileHitRows, dupeRows, treeRows } from '../src/storage-command.js';
import { awstorageWhoami, shareStoragePath, searchStorageFiles } from '../src/storage-client.js';

type Call = { method: 'GET' | 'POST'; path: string; body?: any };

function fakeClient(reply: (c: Call) => any): { client: any; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async getDetailed(path: string) {
      const c: Call = { method: 'GET', path };
      calls.push(c);
      return reply(c);
    },
    async postDetailed(path: string, body: any) {
      const c: Call = { method: 'POST', path, body };
      calls.push(c);
      return reply(c);
    },
  };
  return { client, calls };
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const log = console.log;
  const error = console.error;
  let out = '';
  let err = '';
  console.log = (...a: any[]) => { out += a.join(' ') + '\n'; };
  console.error = (...a: any[]) => { err += a.join(' ') + '\n'; };
  try {
    const result = await fn();
    return { result, out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('find: sends q + filters to /files/search with the contract param names', async () => {
  const { client, calls } = fakeClient(() => ({
    items: [{ node: 'desk', path: 'E:/docs/a.pdf', size: 2048, mtime: 1_700_000_000, ext: 'pdf', mime: 'application/pdf', sha256: null }],
    next_cursor: null,
  }));
  const { result, out } = await quiet(() =>
    runStorageCommand(['find', 'invoice', '--node', 'desk', '--ext', 'pdf', '--min-bytes', '1024', '--newer', '7'], client),
  );
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  const url = new URL(`http://x${calls[0].path}`);
  assert.equal(url.pathname, '/api/v1/storage/files/search');
  assert.equal(url.searchParams.get('q'), 'invoice');
  assert.equal(url.searchParams.get('node'), 'desk');
  assert.equal(url.searchParams.get('ext'), 'pdf');
  assert.equal(url.searchParams.get('min_bytes'), '1024');
  assert.equal(url.searchParams.get('newer_days'), '7');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.match(out, /E:\/docs\/a\.pdf/);
});

test('find: no query is a usage error (2) and never calls Genesis', async () => {
  const { client, calls } = fakeClient(() => ({ items: [] }));
  const { result } = await quiet(() => runStorageCommand(['find'], client));
  assert.equal(result, 2);
  assert.equal(calls.length, 0);
});

test('find: an unreachable Genesis is a failure (1), never an empty result', async () => {
  const { client } = fakeClient(() => ({ error: 'fetch failed', status: 0 }));
  const { result, err } = await quiet(() => runStorageCommand(['find', 'x'], client));
  assert.equal(result, 1);
  assert.match(err, /cannot reach Genesis/);
});

test('find: 403 is surfaced as not authorized', async () => {
  const { client } = fakeClient(() => ({ error: 'not your node', status: 403 }));
  const { result, err } = await quiet(() => runStorageCommand(['find', 'x', '--node', 'someone-else'], client));
  assert.equal(result, 1);
  assert.match(err, /not authorized \(403\)/);
});

test('dupes: hits /files/dupes; reclaimable is ACTIONABLE bytes, not raw waste', async () => {
  const { client, calls } = fakeClient(() => ({
    groups: [
      { sha256: 'a'.repeat(64), bytes: 1024, count: 3, wasted_bytes: 2048, actionable_bytes: 1024, paths: [{ node: 'desk', path: '/a' }, { node: 'desk', path: '/b' }, { node: 'desk', path: '/c' }] },
    ],
    total_wasted_bytes: 2048,
  }));
  const { result, out } = await quiet(() => runStorageCommand(['dupes', '--min-bytes', '100'], client));
  assert.equal(result, 0);
  const url = new URL(`http://x${calls[0].path}`);
  assert.equal(url.pathname, '/api/v1/storage/files/dupes');
  assert.equal(url.searchParams.get('min_bytes'), '100');
  assert.match(out, /1\.0KB reclaimable, 2\.0KB duplicated/);
  assert.match(out, /\+2 more/);
});

test('dupes: min_bytes defaults to 1 MiB', async () => {
  const { client, calls } = fakeClient(() => ({ groups: [] }));
  await quiet(() => runStorageCommand(['dupes'], client));
  assert.equal(new URL(`http://x${calls[0].path}`).searchParams.get('min_bytes'), String(1024 * 1024));
});

test('empty answers are one of three states, never a silent empty', async () => {
  const notIndexed = fakeClient(() => ({ path: '', children: [], indexed_roots: [] }));
  const a = await quiet(() => runStorageCommand(['tree'], notIndexed.client));
  assert.match(a.out, /no node is indexed yet/);
  assert.match(a.out, /awstorage files scan --all-volumes && awstorage push/);
  const stale = fakeClient(() => ({ items: [], indexed_roots: [{ root: '/' }], stale: true }));
  const b = await quiet(() => runStorageCommand(['find', 'x'], stale.client));
  assert.match(b.out, /stale/);
  const none = fakeClient(() => ({ groups: [], indexed_roots: [{ root: '/' }] }));
  const c = await quiet(() => runStorageCommand(['dupes'], none.client));
  assert.match(c.out, /no duplicate content/);
});

test('tree: positional path + depth go to /files/tree', async () => {
  const { client, calls } = fakeClient(() => ({
    path: 'E:/',
    children: [
      { name: 'small', kind: 'dir', bytes: 10, files: 1 },
      { name: 'big', kind: 'dir', bytes: 10_000, files: 5 },
    ],
  }));
  const { result, out } = await quiet(() => runStorageCommand(['tree', 'E:/', '--depth', '2', '--node', 'desk'], client));
  assert.equal(result, 0);
  const url = new URL(`http://x${calls[0].path}`);
  assert.equal(url.pathname, '/api/v1/storage/files/tree');
  assert.equal(url.searchParams.get('path'), 'E:/');
  assert.equal(url.searchParams.get('depth'), '2');
  assert.ok(out.indexOf('big/') < out.indexOf('small/'), 'largest first');
});

test('share: POSTs only {node,path[,seal]} and reports the proposal, never an approval', async () => {
  const { client, calls } = fakeClient(() => ({ proposal_id: 'p-1', status: 'proposed', card_id: 'dc-9' }));
  const { result, out } = await quiet(() => runStorageCommand(['share', 'E:/docs', '--node', 'desk', '--seal'], client));
  assert.equal(result, 0);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/v1/storage/share');
  assert.deepEqual(calls[0].body, { node: 'desk', path: 'E:/docs', seal: true });
  assert.match(out, /proposal p-1/);
  assert.match(out, /decision card dc-9/);
});

test('share: missing --node uses awstorage whoami (env first), never a bare guess', async () => {
  const prev = process.env.AWSTORAGE_NODE;
  process.env.AWSTORAGE_NODE = 'debian-fleet';
  try {
    const { client, calls } = fakeClient(() => ({ proposal_id: 'p-2' }));
    const { result, out } = await quiet(() => runStorageCommand(['share', 'E:/docs'], client));
    assert.equal(result, 0);
    assert.deepEqual(calls[0].body, { node: 'debian-fleet', path: 'E:/docs' });
    assert.match(out, /env:AWSTORAGE_NODE/);
  } finally {
    if (prev === undefined) delete process.env.AWSTORAGE_NODE;
    else process.env.AWSTORAGE_NODE = prev;
  }
});

test('awstorageWhoami: env, then ~/.aither/node-id, then hostname', () => {
  const noFile = () => { throw new Error('ENOENT'); };
  assert.equal(awstorageWhoami({ env: { AWSTORAGE_NODE: 'e' }, readFile: noFile, home: () => '/h', host: () => 'h' }).node, 'e');
  const f = awstorageWhoami({ env: {}, readFile: () => 'local\n', home: () => '/h', host: () => 'h' });
  assert.equal(f.node, 'local');
  assert.match(f.source, /^file:/);
  assert.deepEqual(awstorageWhoami({ env: {}, readFile: () => 'bad id!', home: () => '/h', host: () => 'h' }),
    { node: 'h', source: 'hostname' });
});

test('share: a missing path is a usage error and sends nothing', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const { result } = await quiet(() => runStorageCommand(['share'], client));
  assert.equal(result, 2);
  assert.equal(calls.length, 0);
});

test('shareStoragePath: omits seal when not requested', async () => {
  const { client, calls } = fakeClient(() => ({ proposal_id: 'p' }));
  const r = await shareStoragePath(client, { node: 'n', path: '/p' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].body, { node: 'n', path: '/p' });
});

test('searchStorageFiles: error shape is preserved (status + detail)', async () => {
  const { client } = fakeClient(() => ({ error: 'awstorage unavailable', status: 503 }));
  const r = await searchStorageFiles(client, { q: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('shares: lists /shares', async () => {
  const { client, calls } = fakeClient(() => ({ shares: [{ id: 's1', status: 'published', node: 'desk', path: '/a', handle: 'h1' }] }));
  const { result, out } = await quiet(() => runStorageCommand(['shares'], client));
  assert.equal(result, 0);
  assert.equal(calls[0].path, '/api/v1/storage/shares');
  assert.match(out, /h1/);
});

test('pure row builders', () => {
  assert.deepEqual(fileHitRows([{ node: 'n', path: '/p', bytes: 0 }])[0].slice(0, 2), ['n', '0B']);
  const d = dupeRows([
    { sha256: 'x', bytes: 1, count: 2, wasted_bytes: 1, paths: [{ node: 'n', path: '/a' }, { node: 'n', path: '/b' }] },
    { sha256: 'y', bytes: 1, count: 2, wasted_bytes: 5, paths: [] },
  ]);
  assert.equal(d[0][3], 'y');
  assert.equal(d[0][4], '-');
  assert.equal(treeRows([{ name: 'f', kind: 'file', bytes: 1 }])[0][0], 'f');
});
