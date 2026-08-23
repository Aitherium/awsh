/**
 * A password typed into awsh must not survive the session.
 *
 * Reported live 2026-08-22, setting a GobboNet app password:
 *
 *     / /password
 *     /password <new-password>   at least 4 characters
 *
 * The help did not merely permit the secret on the command line, it INSTRUCTED
 * it. Two consequences, and only one of them was visible:
 *
 *   - the characters are echoed and sit in terminal scrollback;
 *   - `saveHistory(config.historyFile, input)` runs at the TOP of processLine,
 *     before any dispatch, so the line is appended to a FILE ON DISK in
 *     plaintext and re-read into the next session's history.
 *
 * The second is the one that outlives the terminal, and nothing anywhere
 * reported it: writing a secret to a file is a completely successful write.
 *
 * These are the pure halves of the fix. The interactive prompt is exercised by
 * hand (it needs a TTY in raw mode); what is asserted here is the rule that
 * decides whether a line ever reaches disk, because that is the half that
 * fails silently.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isSecretBearing, redactForHistory } from '../src/secret-input.js';

test('the reported line never reaches the history file intact', () => {
  assert.equal(isSecretBearing('/password hunter2'), true);
  assert.equal(redactForHistory('/password hunter2'), '/password ***');
  // The value must be gone, not merely shortened.
  assert.ok(!redactForHistory('/password hunter2').includes('hunter2'));
});

test('a bare /password IS kept — the safe form should stay re-runnable', () => {
  // Redacting this too would be strictly worse: pressing Up to re-run the
  // interactive form is the behaviour the fix exists to encourage, and a
  // history filter that fires on harmless lines gets switched off.
  assert.equal(isSecretBearing('/password'), false);
  assert.equal(isSecretBearing('  /password  '), false);
});

test('the slashless and aliased spellings are covered', () => {
  // The REPL dispatches `/password`; `password` reaches the same handler on
  // other lanes, and `--set-password` is the flag form the docs mention.
  for (const line of ['password hunter2', '/passwd hunter2', '/set-password hunter2']) {
    assert.equal(isSecretBearing(line), true, line);
    assert.ok(!redactForHistory(line).includes('hunter2'), line);
  }
});

test('inline credential FLAGS are caught on any command', () => {
  const cases = [
    '/login --password hunter2',
    'awsh gobbonet --token=ghp_abcdefghijklmnop',
    '/deploy --api-key sk-live-1234567890',
    '/x --secret=swordfish',
  ];
  for (const line of cases) {
    assert.equal(isSecretBearing(line), true, line);
    const red = redactForHistory(line);
    assert.ok(!/hunter2|ghp_abcdefghijklmnop|sk-live-1234567890|swordfish/.test(red), red);
    assert.ok(red.includes('***'), red);
  }
});

test('the command survives redaction — history must not lie about what was run', () => {
  // Dropping the whole line would make the history silently disagree with what
  // happened, which is its own small untruth. Keep the verb, lose the value.
  assert.equal(redactForHistory('/password hunter2'), '/password ***');
  assert.ok(redactForHistory('/login --password hunter2').startsWith('/login'));
});

test('ordinary lines are untouched — a filter that floods gets switched off', () => {
  const ordinary = [
    'what time is it?',
    '/gui',
    '/help',
    'git commit -m "fix the password reset flow"',
    'grep -rn password src/',
    '/model bonsai-4b',
    'tell me about password managers',
  ];
  for (const line of ordinary) {
    assert.equal(isSecretBearing(line), false, line);
    assert.equal(redactForHistory(line), line.trim(), line);
  }
});

test('a mention of the word is not a use of it', () => {
  // The discriminator is the COMMAND, not the look of the value. A rule that
  // tried to recognise "this looks like a password" would either miss `hunter2`
  // or redact half the transcript.
  assert.equal(isSecretBearing('how do I change my password'), false);
  assert.equal(isSecretBearing('/help password'), false);
});
