/**
 * The cockpit decides a steer from the daemon's row.actions + why_not
 * (adk/harnesses/session_verbs.py row_actions), not from steer_capability.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steerFocusedSession, steerPlan } from '../src/session-steer.js';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'aaaa1111bbbb2222', title: 'awdk', status: 'idle', steer_capability: 'full', ...over,
}) as any;

const WHY = 'the codex harness does not drain the steering mailbox -- use its input instead';

test('a row with actions.message false is refused with its why_not even when steer_capability says full', async () => {
  const r0 = row({ actions: { message: false, input: false, interrupt: false, focus: false, why_not: { message: WHY, input: 'x' } } });
  const plan = steerPlan(r0);
  assert.equal(plan.allowed, false);
  assert.equal(plan.note, WHY);
  const calls: string[] = [];
  const api = (async (p: string) => { calls.push(p); return {}; }) as any;
  const r = await steerFocusedSession(r0, 'hello', { api, receiptTimeoutMs: 0 });
  assert.equal(r.ok, false);
  assert.match(r.message, /does not drain the steering mailbox/);
  assert.equal(calls.length, 0, 'nothing may be published for a row the daemon refuses');
});

test('actions.message true is allowed even when steer_capability says none', () => {
  const plan = steerPlan(row({ steer_capability: 'none', actions: { message: true, input: false, why_not: { input: 'discovered' } } }));
  assert.equal(plan.allowed, true);
  assert.equal(plan.when, 'turn-boundary');
});

test('actions.input true lands now (the pty tier), message or not', () => {
  const plan = steerPlan(row({ actions: { message: false, input: true, why_not: { message: 'no claude id yet' } } }));
  assert.equal(plan.allowed, true);
  assert.equal(plan.when, 'now');
});

test('a row without actions (older daemon) keeps the steer_capability fallback', () => {
  assert.equal(steerPlan(row()).when, 'now');
  assert.equal(steerPlan(row({ steer_capability: 'none' })).allowed, false);
});
