/**
 * The cockpit's focus-viewer input line steers the focused row per its capability
 * tier, over the same steering-event path as `aither harness tell`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steerFocusedSession, steerPlan } from '../src/session-steer.js';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'aaaa1111bbbb2222', title: 'awdk', status: 'idle', steer_capability: 'full', ...over,
}) as any;

function fakeApi(receipt?: Record<string, unknown>) {
  const calls: { path: string; body?: any }[] = [];
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/events') return { seq: 10 } as T;
    return { events: receipt ? [{ type: 'steering_receipt', seq: 11, payload: receipt }] : [] } as T;
  };
  return { api, calls };
}

test('capability tier decides the plan before anything is sent', () => {
  assert.equal(steerPlan(row()).when, 'now');
  assert.equal(steerPlan(row({ steer_capability: 'turn-boundary' })).when, 'turn-boundary');
  assert.equal(steerPlan(row({ steer_capability: 'none' })).allowed, false);
  assert.equal(steerPlan(row({ status: 'exited' })).allowed, false);
});

test('a full-capability row is told through a steering event addressed to exactly it', async () => {
  const { api, calls } = fakeApi({ target: 'aaaa1111bbbb2222', channel: 'pty', landed_now: true, detail: 'typed' });
  const r = await steerFocusedSession(row(), '  look at the gate  ', { api, receiptTimeoutMs: 0 });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /landed now/);
  const ev = calls.find((c) => c.path === '/events')!.body;
  assert.equal(ev.type, 'steering');
  assert.deepEqual(ev.to, ['aaaa1111bbbb2222']);
  assert.equal(ev.payload.text, 'look at the gate');
});

test('a view-only row (cap none) or an exited one is refused WITHOUT publishing', async () => {
  for (const r0 of [row({ steer_capability: 'none' }), row({ status: 'exited' })]) {
    const { api, calls } = fakeApi();
    const r = await steerFocusedSession(r0, 'hello', { api, receiptTimeoutMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0, 'nothing may be published for a row that cannot read it');
  }
});

test('a receipt with channel none is not delivered; a thrown api is a message, not a throw', async () => {
  const { api } = fakeApi({ target: 'aaaa1111bbbb2222', channel: 'none', detail: 'no pty' });
  const r = await steerFocusedSession(row({ steer_capability: 'turn-boundary' }), 'x', { api, receiptTimeoutMs: 0 });
  assert.equal(r.ok, false);
  assert.match(r.message, /not delivered/);
  const boom = async () => { throw new Error('fetch failed'); };
  const r2 = await steerFocusedSession(row(), 'x', { api: boom as any, receiptTimeoutMs: 0 });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /fetch failed/);
});

test('a daemon reply without seq never adopts an older receipt for the same target', async () => {
  const stale = { target: 'aaaa1111bbbb2222', channel: 'pty', landed_now: true, detail: 'an EARLIER send' };
  const api = (async <T,>(path: string): Promise<T> => {
    if (path === '/events') return { ok: true } as T;
    return { events: [{ type: 'steering_receipt', seq: 5, payload: stale }] } as T;
  }) as any;
  const r = await steerFocusedSession(row(), 'x', { api, receiptTimeoutMs: 0 });
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.message, /an EARLIER send/);
  assert.match(r.message, /not correlatable/);
});
