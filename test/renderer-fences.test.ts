/**
 * sanitizeCodeFences — model markdown must not break the terminal highlighter.
 *
 * Regression (seen live 2026-09-12 in a remote-shell answer): the model wrote
 * "```powershell" then, without closing it, a prose line "A few practical
 * notes:". marked handed that line to highlight.js as a LANGUAGE, which logged
 * `Could not find the language 'A few practical notes:'` and mangled the
 * re-render. Unclosed fences also swallowed the rest of the message as code.
 *
 * Ported from the public mirror, where this was fixed first and lived ONLY on
 * the mirror. The sync lane mirrors cli/** destructively (a keep-list wipe), so
 * a fix that exists only on the mirror is a fix the next sync deletes -- hence
 * the tests travelling with the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCodeFences } from '../src/renderer.js';

test('a prose info-string is dropped to plaintext (no bogus language)', () => {
  const out = sanitizeCodeFences('```A few practical notes:\nhello\n```');
  assert.equal(out.split('\n')[0], '```');
});

test('a real language is preserved', () => {
  const out = sanitizeCodeFences('```powershell\nGet-ChildItem\n```');
  assert.equal(out.split('\n')[0], '```powershell');
});

test('only the first token is taken as the language', () => {
  const out = sanitizeCodeFences('```js title=example.js\nx\n```');
  assert.equal(out.split('\n')[0], '```js');
});

test('an unclosed fence is closed so trailing prose is not swallowed', () => {
  const out = sanitizeCodeFences('```powershell\nhostname\n\nA few notes here');
  assert.ok(out.endsWith('```'), 'dangling fence is closed at EOF');
  assert.equal((out.match(/```/g) || []).length, 2);
});

test('well-formed markdown passes through untouched', () => {
  const md = 'text\n\n```python\nprint(1)\n```\n\nmore';
  assert.equal(sanitizeCodeFences(md), md);
});

test('the exact live case: unclosed powershell fence + prose line', () => {
  const md = 'Try these:\n```powershell\nhostname\nwhoami\nA few practical notes:\n- exit closes it';
  const out = sanitizeCodeFences(md);
  assert.ok(!/```A few/.test(out));
  assert.ok(out.endsWith('```'));
});
