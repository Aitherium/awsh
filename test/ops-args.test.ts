/**
 * `aither ops` — the argv parser and the dry-run default, against a fake client.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpsArgs, runOpsCommand } from '../src/ops-command.js';

test('parseOpsArgs: noun, verb, k=v params and flags', () => {
  const a = parseOpsArgs(['backups', 'restore', 'set_id=config', 'target_dir=/tmp/r1',
    '--apply', '--agent', 'genesis', '--watch']);
  assert.equal(a.noun, 'backups');
  assert.equal(a.verb, 'restore');
  assert.deepEqual(a.params, { set_id: 'config', target_dir: '/tmp/r1' });
  assert.equal(a.apply, true);
  assert.equal(a.agent, 'genesis');
  assert.equal(a.watch, true);
});

test('parseOpsArgs: dry run is the default', () => {
  const a = parseOpsArgs(['backups', 'verify']);
  assert.equal(a.apply, false);
  assert.equal(a.agent, '');
});

function fakeClient(calls: any[]) {
  const catalog = {
    ops: [
      { id: 'backups.verify', noun: 'backups', verb: 'verify', kind: 'action', risk: 'safe',
        scope: 'platform', approval: 'none', params: {} },
      { id: 'backups.run', noun: 'backups', verb: 'run', kind: 'action', risk: 'guarded',
        scope: 'platform', approval: 'card', params: {} },
    ],
  };
  return {
    async requestDetailed(method: string, path: string, body?: any) {
      calls.push({ method, path, body });
      if (path.endsWith('/catalog')) return catalog;
      if (path.endsWith('/runs') && body?.dry_run) {
        return { dry_run: true, would: { calls: ['POST /recover/backup/sets/verify'] },
          approval_required: false };
      }
      if (path.endsWith('/runs')) {
        return { dry_run: false, run: { id: 'run_1', op: body.op, state: 'running',
          actor: { kind: 'human', id: 'u', via: 'cli' } } };
      }
      return { error: 'unexpected', status: 500 };
    },
  } as any;
}

test('runOpsCommand: without --apply it sends dry_run=true and via=cli', async () => {
  const calls: any[] = [];
  const code = await runOpsCommand(['backups', 'verify'], fakeClient(calls));
  assert.equal(code, 0);
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.dry_run, true);
  assert.equal(post.body.via, 'cli');
  assert.equal(post.body.op, 'backups.verify');
});

test('runOpsCommand: --apply --agent genesis starts a delegated run', async () => {
  const calls: any[] = [];
  const code = await runOpsCommand(['backups', 'verify', '--apply', '--agent', 'genesis'],
    fakeClient(calls));
  assert.equal(code, 0);
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.body.dry_run, false);
  assert.equal(post.body.delegate_to, 'genesis');
});

test('runOpsCommand: an unknown verb is a usage error, not a silent 0', async () => {
  const calls: any[] = [];
  const code = await runOpsCommand(['backups', 'explode'], fakeClient(calls));
  assert.equal(code, 2);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});
