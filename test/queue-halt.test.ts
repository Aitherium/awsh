/**
 * The endless red waterfall (measured live 2026-08-15): a long multi-line paste
 * submitted one message per line, and the drain loop replayed all ~30 into a backend
 * that was signed-out / unreachable — 30 identical failures the user could not stop
 * with Ctrl+C. runChatDraining now halts the queue on the first hard failure; these
 * assert the classification that picks the halt message, against the ACTUAL error
 * strings the CLI produced that day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { haltNeedsLogin, haltMessage } from '../src/tui/queue-halt.js';

test('the live auth failure routes to /login', () => {
  const reason = 'Cloud gateway requires sign-in — run /login to authenticate, or start local AitherOS';
  assert.equal(haltNeedsLogin(reason), true);
  assert.match(haltMessage(29, reason), /\/login/);
  assert.match(haltMessage(29, reason), /29 more queued/);
});

test('a plain connection failure routes to "wait for backend", not /login', () => {
  const reason = 'Cannot connect to inference endpoint (https://gateway.aitherium.com/v1/chat/completions)';
  assert.equal(haltNeedsLogin(reason), false);
  assert.doesNotMatch(haltMessage(5, reason), /\/login/);
  assert.match(haltMessage(5, reason), /backend unreachable/);
});

test('mid-turn stream death is treated as a generic unreachable failure', () => {
  assert.equal(haltNeedsLogin('connection closed mid-turn'), false);
  assert.equal(haltNeedsLogin('backend unreachable'), false);
});

test('other auth phrasings still route to /login (401/403/unauthorized)', () => {
  for (const r of ['HTTP 401 Unauthorized', 'got a 403', 'authentication required', 'please log in']) {
    assert.equal(haltNeedsLogin(r), true, `expected login route for: ${r}`);
  }
});
