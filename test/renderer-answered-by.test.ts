/**
 * The footer says which model answered when it was not the one asked for.
 *
 * MicroScheduler answers a busy or parked lane from a resident stand-in
 * (AITHER_MODEL_STANDINS) and Genesis carries its route on the complete event as
 * `route: {requested, served_by, cross_model: true}`. Without this line a person
 * reading the terminal had no way to know a different model wrote the answer.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createStreamRenderer } from '../src/renderer.js';

function capture(fn: () => void): string {
  const lines: string[] = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  (process.stdout as any).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
  try { fn(); } finally { console.log = origLog; (process.stdout as any).write = origWrite; }
  return lines.join(String.fromCharCode(10));
}

function turn(route: unknown): string {
  return capture(() => {
    const r = createStreamRenderer('s-route', 'vaporwave');
    r.onEvent({
      type: 'complete',
      data: { type: 'complete', content: 'hello', model: 'gemma4-12b', route },
    } as never);
    r.finish();
  });
}

describe('renderer: a stand-in answer is labelled', () => {
  test('a cross-model route prints who answered and who was asked', () => {
    const out = turn({ requested: 'gemma4-12b', served_by: 'bonsai2-27b', cross_model: true });
    assert.match(out, /answered by bonsai2-27b \(asked for gemma4-12b\)/);
  });

  test('an ordinary reply prints no note', () => {
    assert.doesNotMatch(turn(undefined), /answered by/);
    assert.doesNotMatch(turn({ requested: 'a', served_by: 'a', cross_model: false }), /answered by/);
  });
});
