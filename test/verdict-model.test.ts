/**
 * A placeholder must never be rendered as a model name (measured live 2026-07-29).
 *
 * The trace drawer showed `● Verdict · 102.2s · unknown` on turns that had
 * SUCCEEDED, because the backend sends `model: "unknown"` on terminal events and
 * extractMetrics took it verbatim. That reads as a failed/unrouted turn and was
 * reported as "no indication of what's going on" — strictly worse than printing
 * no model. controller.ts already filtered exactly these for the footer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMetrics } from '../src/tui/event-schema.js';

test('the live regression: model "unknown" is dropped, not rendered', () => {
  const m = extractMetrics('complete', { model: 'unknown', duration_ms: 102200 });
  assert.equal(m.model, undefined, 'literal "unknown" must not become a model name');
  assert.equal(m.ms, 102200, 'real metrics still extracted');
});

test('every placeholder form is dropped, case/space insensitive', () => {
  for (const v of ['unknown', 'UNKNOWN', ' Unknown ', 'auto', 'default', 'none',
                   'null', 'n/a', '-', '', '   ']) {
    assert.equal(extractMetrics('complete', { model: v }).model, undefined,
      `model=${JSON.stringify(v)} must be dropped`);
  }
});

test('a REAL model name is still shown', () => {
  assert.equal(extractMetrics('complete', { model: 'test-model' }).model,
    'test-model');
  assert.equal(extractMetrics('complete', { model_used: 'deepseek-v4-pro' }).model,
    'deepseek-v4-pro');
});

test('model_used wins, but falls through to model when it is a placeholder', () => {
  // Terminal events often carry BOTH: model_used="unknown", model="<real>".
  // Preferring model_used blindly is what hid the real name.
  assert.equal(
    extractMetrics('complete', { model_used: 'unknown', model: 'test-model' }).model,
    'test-model');
  assert.equal(
    extractMetrics('complete', { model_used: 'kimi-k3', model: 'unknown' }).model,
    'kimi-k3');
});

test('absent model fields leave model undefined', () => {
  assert.equal(extractMetrics('complete', { duration_ms: 10 }).model, undefined);
  assert.equal(extractMetrics('complete', {}).model, undefined);
});

test('non-string model values are handled without throwing', () => {
  assert.equal(extractMetrics('complete', { model: null }).model, undefined);
  assert.equal(extractMetrics('complete', { model: 123 }).model, '123');
});
