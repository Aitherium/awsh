/**
 * StreamRenderer.begin() -- indication must exist BEFORE the first SSE event.
 *
 * Every startSpinner() call site in renderer.ts lives inside onEvent(), and the
 * earliest fires on `session_start`. So the window between the user pressing
 * Enter and the first byte off the wire had no indication of any kind: no
 * spinner, no text, nothing. Measured 2026-09-02 -- a cloud-routed turn ran
 * 133.4s and the owner reported it as a hang, because a slow answer and a wedged
 * process look identical from the outside.
 *
 * The size of that window is a property of whichever backend answered (0.24s to
 * the local daemon, a full network round trip to the gateway), so it is
 * unbounded and cannot be left uncovered.
 *
 * These tests assert the BEHAVIOUR, not the spelling: they force a TTY, capture
 * stderr (where ora writes), and require bytes to appear from begin() alone --
 * with no event ever delivered. Reverting begin() to a no-op fails the first
 * test; deleting it entirely fails compilation and the second.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { createStreamRenderer } from '../src/renderer.js';

/** Run fn with stderr forced to a TTY, returning everything written to it. */
function captureStderr(fn: () => void): string {
  const realWrite = process.stderr.write.bind(process.stderr);
  const realIsTTY = (process.stderr as NodeJS.WriteStream).isTTY;
  const realColumns = (process.stderr as NodeJS.WriteStream).columns;
  let out = '';
  (process.stderr as NodeJS.WriteStream).isTTY = true;
  (process.stderr as NodeJS.WriteStream).columns = 80;
  (process.stderr as any).write = (chunk: any) => {
    out += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  // Declaring isTTY makes ora drive the cursor, and a plain (non-tty) stderr
  // has no cursorTo/clearLine/moveCursor. Stub them or the harness throws and
  // the failure reads as a defect in begin() rather than in this file.
  const stubbed: Record<string, any> = {};
  for (const m of ['cursorTo', 'clearLine', 'moveCursor'] as const) {
    stubbed[m] = (process.stderr as any)[m];
    (process.stderr as any)[m] = () => true;
  }
  try {
    fn();
  } finally {
    (process.stderr as any).write = realWrite;
    (process.stderr as NodeJS.WriteStream).isTTY = realIsTTY;
    (process.stderr as NodeJS.WriteStream).columns = realColumns;
    for (const m of Object.keys(stubbed)) (process.stderr as any)[m] = stubbed[m];
  }
  return out;
}

describe('StreamRenderer.begin() -- indication before the first event', () => {
  test('writes to stderr with NO event ever delivered', () => {
    const out = captureStderr(() => {
      const r = createStreamRenderer();
      r.begin();
      r.finish(true);  // aborted -- suppresses the end-of-turn warning
    });
    // ora writes its frame to stderr. Before begin() existed this was empty,
    // which is exactly the 133.4s of dead air.
    assert.ok(
      out.length > 0,
      'begin() produced no output -- the pre-first-byte window is unindicated again',
    );
  });

  test('the default text is shown, so the line is not merely blank escape codes', () => {
    const out = captureStderr(() => {
      const r = createStreamRenderer();
      r.begin();
      r.finish(true);
    });
    // Strip ANSI so the assertion survives colour/spinner-frame changes.
    const plain = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.match(
      plain,
      /Connecting/i,
      'begin() wrote control codes but no readable text -- a blank spinner still ' +
      'reads as a hang',
    );
  });

  test('a caller-supplied label is honoured', () => {
    const out = captureStderr(() => {
      const r = createStreamRenderer();
      r.begin('Reaching the daemon...');
      r.finish(true);
    });
    const plain = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.match(plain, /Reaching the daemon/, 'begin(text) ignored its argument');
  });

  test('begin() is on the public StreamRenderer surface, so every implementer must have it', () => {
    const r = createStreamRenderer();
    assert.equal(
      typeof r.begin, 'function',
      'begin() missing -- tui/controller.ts and main.ts both call it',
    );
    r.finish(true);
  });
});
