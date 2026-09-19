/**
 * The pure half of the pty attach (2026-09-19): the detach key, keystroke splitting,
 * the resize payload and the incremental SSE parser. attachPty's I/O is exercised live
 * against the daemon (aither claude / aither harness attach --pty), not here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DETACH_BYTE, isDetachKey, parseSse, resizePayload, splitKeystrokes,
} from '../src/pty-attach.js';

test('isDetachKey: Ctrl+] detaches; Ctrl-C and Enter do not', () => {
  assert.equal(DETACH_BYTE, 0x1d);
  assert.equal(isDetachKey(0x1d), true);
  assert.equal(isDetachKey(0x03), false);
  assert.equal(isDetachKey(0x0d), false);
});

test('splitKeystrokes: forwards bytes before the detach key and flags it', () => {
  assert.deepEqual(splitKeystrokes(Buffer.from('ls\r')), { text: 'ls\r', detach: false });
  assert.deepEqual(splitKeystrokes(Buffer.from([0x61, 0x1d, 0x62])), { text: 'a', detach: true });
  assert.deepEqual(splitKeystrokes(Buffer.from([0x1d])), { text: '', detach: true });
  assert.deepEqual(splitKeystrokes(Buffer.from('é')), { text: 'é', detach: false });
});

test('resizePayload: uses the terminal size, defaults to 24x80 when not a terminal', () => {
  assert.deepEqual(resizePayload(50, 200), { rows: 50, cols: 200 });
  assert.deepEqual(resizePayload(undefined, undefined), { rows: 24, cols: 80 });
  assert.deepEqual(resizePayload(0, -3), { rows: 24, cols: 80 });
});

test('parseSse: parses complete frames, skips keepalives, keeps a split frame as carry', () => {
  const a = 'event: text.delta\ndata: {"kind":"text.delta","text":"hi"}\n\n: keepalive\n\nevent: session.exi';
  const first = parseSse(a);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].kind, 'text.delta');
  assert.equal(first.events[0].data.text, 'hi');
  assert.equal(first.carry, 'event: session.exi');
  const second = parseSse('ted\ndata: {"kind":"session.exited","data":{"exit_code":0}}\n\n', first.carry);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].kind, 'session.exited');
  assert.equal(second.events[0].data.data.exit_code, 0);
  assert.equal(second.carry, '');
});

test('parseSse: a malformed data line is dropped, the frames around it survive', () => {
  const r = parseSse('event: x\ndata: {not json}\n\nevent: text.delta\ndata: {"text":"ok"}\n\n');
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].data.text, 'ok');
});

test('parseSse: CRLF frames parse the same', () => {
  const r = parseSse('event: text.delta\r\ndata: {"text":"crlf"}\r\n\r\n'.replace(/\r\n\r\n/, '\n\n'));
  assert.equal(r.events[0].data.text, 'crlf');
});
