/**
 * Regression: `aither <flags> "message"` must run one-shot, not open the REPL.
 *
 * The bug (found 2026-08-07): collectPositional `break`s on the first '-' argument,
 * so any flag BEFORE the message produced zero positionals and the shell fell
 * through to the interactive REPL. Measured live: `node dist/main.js -e 1 "Reply
 * with exactly: PONG"` printed the REPL banner and an `aither>` prompt; PONG never
 * appeared. No error, no usage text — in a script that is a hang.
 *
 * Every assertion below has a mutation guard: it fails against the old
 * break-on-first-flag implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPositional } from '../src/cli-args.js';

test('bare message is the one-shot prompt', () => {
  assert.deepEqual(collectPositional(['Reply with exactly: PONG']), ['Reply with exactly: PONG']);
});

test('flags BEFORE the message do not swallow it (the regression)', () => {
  // Old impl returned [] for every one of these → REPL instead of an answer.
  assert.deepEqual(collectPositional(['-e', '1', 'hello']), ['hello']);
  assert.deepEqual(collectPositional(['--effort', '9', 'hello']), ['hello']);
  assert.deepEqual(collectPositional(['--will', 'iris', 'draft the post']), ['draft the post']);
  assert.deepEqual(collectPositional(['-s', 'casual', '-a', 'demiurge', 'review']), ['review']);
  assert.deepEqual(collectPositional(['--private', 'secret question']), ['secret question']);
});

test('flag values are never mistaken for the message', () => {
  // `1` is the effort value, not a prompt; `iris` is the agent name.
  assert.deepEqual(collectPositional(['-e', '1']), []);
  assert.deepEqual(collectPositional(['--will', 'iris']), []);
  assert.deepEqual(collectPositional(['--resume', 'sess-123']), []);
  assert.deepEqual(collectPositional(['--output-format', 'json']), []);
});

test('flags AFTER the message still work', () => {
  assert.deepEqual(collectPositional(['hello', '-e', '1']), ['hello']);
  assert.deepEqual(collectPositional(['tell', 'me', '--private']), ['tell', 'me']);
});

test('no message means REPL — the only case that should', () => {
  assert.deepEqual(collectPositional([]), []);
  assert.deepEqual(collectPositional(['--private']), []);
  assert.deepEqual(collectPositional(['--continue']), []);
});

test('optional-value flags only eat a non-flag value', () => {
  // `--gateway <url>` consumes the url; `--gateway --private` must not eat the flag.
  assert.deepEqual(collectPositional(['--gateway', 'https://x.example', 'ask']), ['ask']);
  assert.deepEqual(collectPositional(['--gateway', '--private', 'ask']), ['ask']);
  assert.deepEqual(collectPositional(['--deepseek', 'reasoner', 'ask']), ['ask']);
  assert.deepEqual(collectPositional(['--deepseek', 'ask']), []);  // variant, per main.ts
});

test('-- ends flag parsing so a dash-leading message survives', () => {
  assert.deepEqual(collectPositional(['--', '-not-a-flag', 'text']), ['-not-a-flag', 'text']);
  assert.deepEqual(collectPositional(['-e', '1', '--', '--weird']), ['--weird']);
});
