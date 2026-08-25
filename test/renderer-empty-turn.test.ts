/**
 * The empty-turn diagnostic.
 *
 * WHY THIS EXISTS (measured 2026-08-21): an omnibox turn sat for 11.7s and
 * printed "(no response)". Direct probes then answered 6/6, so it was written
 * off as a transient -- which is exactly how a real defect gets filed as
 * weather. The message could not distinguish three different facts:
 *
 *   1. the request reached a server and it streamed nothing at all
 *   2. events arrived but none carried content (an early finish, a tool-only
 *      turn, a stream cut mid-flight)
 *   3. events arrived that this renderer has no branch for -- a protocol change
 *      on the other side, which looks identical to the model being silent
 *
 * The renderer already collected every event for the session trace, so the
 * information was present and simply was not being said. A blank is an unknown,
 * not a zero.
 *
 * These assert BEHAVIOUR through the exported factory, not source shape: the
 * thing that regresses is someone simplifying the branch back to a bare string.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createStreamRenderer } from '../src/renderer.js';

/** Run fn with console.log captured. */
function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { fn(); } finally { console.log = orig; }
  return lines.join(String.fromCharCode(10));
}

describe('renderer: an empty turn says WHY it was empty', () => {
  test('no events at all is reported as such, not as a bare blank', () => {
    const out = capture(() => {
      const r = createStreamRenderer('s1', 'vaporwave');
      r.finish();
    });
    assert.match(out, /no response/, 'the empty-turn line vanished entirely');
    assert.match(out, /no events at all/,
      'a zero-event turn must say the server sent nothing - otherwise it is '
      + 'indistinguishable from a model that chose to stay silent');
  });

  test('events that carried no content are counted and named', () => {
    const out = capture(() => {
      const r = createStreamRenderer('s2', 'vaporwave');
      r.onEvent({ type: 'session_start', data: { type: 'session_start' } } as never);
      r.onEvent({ type: 'session_start', data: { type: 'session_start' } } as never);
      r.finish();
    });
    assert.match(out, /2 event\(s\) arrived/,
      'the event COUNT is the one fact that separates "sent nothing" from '
      + '"sent something with no content"');
    assert.match(out, /session_start/,
      'the event KINDS must be named - a protocol change on the other side is '
      + 'otherwise indistinguishable from silence');
    assert.doesNotMatch(out, /no events at all/,
      'a turn that DID receive events must not claim the stream was empty');
  });
});
