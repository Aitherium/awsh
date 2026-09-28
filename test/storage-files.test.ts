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
import { shareStoragePath, searchStorageFiles } from '../src/storage-client.js';

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
    runStorageCommand(['find', 'invoice', '--node', 'desk', '--ext', 'pdf', '--min-size', '1024', '--newer', '7'], client),
  );
  assert.equal(result, 0);
  assert.equal(calls.length, 1);
  const url = new URL(`http://x${calls[0].path}`);
  assert.equal(url.pathname, '/api/v1/storage/files/search');
  assert.equal(url.searchParams.get('q'), 'invoice');
  assert.equal(url.searchParams.get('node'), 'desk');
  assert.equal(url.searchParams.get('ext'), 'pdf');
  assert.equal(url.searchParams.get('min_size'), '1024');
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

test('dupes: hits /files/dupes and prints total reclaimable', async () => {
  const { client, calls } = fakeClient(() => ({
    groups: [
      { sha256: 'a'.repeat(64), size: 1024, count: 3, wasted_bytes: 2048, paths: [{ node: 'desk', path: '/a' }, { node: 'desk', path: '/b' }, { node: 'desk', path: '/c' }] },
    ],
    total_wasted_bytes: 2048,
  }));
  const { result, out } = await quiet(() => runStorageCommand(['dupes', '--min-size', '100'], client));
  assert.equal(result, 0);
  const url = new URL(`http://x${calls[0].path}`);
  assert.equal(url.pathname, '/api/v1/storage/files/dupes');
  assert.equal(url.searchParams.get('min_size'), '100');
  assert.match(out, /2\.0KB reclaimable/);
  assert.match(out, /\+2 more/);
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

test('share: missing --node is a usage error and sends nothing', async () => {
  const { client, calls } = fakeClient(() => ({}));
  const { result } = await quiet(() => runStorageCommand(['share', 'E:/docs'], client));
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
  assert.deepEqual(fileHitRows([{ node: 'n', path: '/p', size: 0 }])[0].slice(0, 2), ['n', '0B']);
  const d = dupeRows([
    { sha256: 'x', size: 1, count: 2, wasted_bytes: 1, paths: [{ node: 'n', path: '/a' }, { node: 'n', path: '/b' }] },
    { sha256: 'y', size: 1, count: 2, wasted_bytes: 5, paths: [] },
  ]);
  assert.equal(d[0][3], 'y');
  assert.equal(d[0][4], '-');
  assert.equal(treeRows([{ name: 'f', kind: 'file', bytes: 1 }])[0][0], 'f');
});
