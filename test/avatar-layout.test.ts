/**
 * The docked avatar must not paint on top of the trace pane.
 *
 * It was doing exactly that: `paintAvatar` wrote at `cols - w - 1` for the full pane height,
 * and the trace box is declared `left: '60%', right: 0` — the same columns. So docking the
 * avatar (Ctrl+P or `/avatar`) interleaved truecolor half-blocks with trace text in the same
 * rows, which reads as a corrupted terminal rather than as a feature. Nothing caught it
 * because the avatar is painted RAW (blessed downsamples 24-bit colour, hence the bypass),
 * so blessed's own layout has no idea the cells are occupied and no render assertion sees it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avatarLayout,
  MIN_TRACE_COLS,
  TRACE_LEFT_FRACTION,
} from '../src/tui/screen.js';

/** 0-based half-open column span the trace pane occupies. */
function traceSpan(screenCols: number, traceRight: number): { start: number; end: number } {
  const start = Math.floor(screenCols * TRACE_LEFT_FRACTION);
  return { start, end: screenCols - traceRight };
}

test('the avatar never overlaps the trace pane, at any terminal width', () => {
  let docked = 0, suppressed = 0;
  for (let cols = 40; cols <= 400; cols += 1) {
    for (const requested of [8, 14, 18, 24, 40, 80, 10_000]) {
      const l = avatarLayout(cols, requested);
      if (l.avatarCols === 0) { suppressed += 1; continue; }
      docked += 1;
      const t = traceSpan(cols, l.traceRight);
      // avatarStartCol is 1-based (an ANSI cursor column); trace spans are 0-based.
      const avatarStart0 = l.avatarStartCol - 1;
      assert.ok(avatarStart0 >= t.end,
        `cols=${cols} req=${requested}: avatar starts at ${avatarStart0} but trace ends at ${t.end}`);
      assert.ok(avatarStart0 + l.avatarCols <= cols,
        `cols=${cols} req=${requested}: avatar runs past the screen edge`);
    }
  }
  // Anti-vacuous: if nothing ever docked, "no overlap" is trivially true and meaningless.
  assert.ok(docked > 500, `only ${docked} docked layouts exercised`);
  assert.ok(suppressed > 0, 'the too-narrow branch was never exercised');
});

test('the trace pane keeps a readable width whenever an avatar is docked', () => {
  for (let cols = 40; cols <= 400; cols += 7) {
    const l = avatarLayout(cols, 10_000);
    if (l.avatarCols === 0) continue;
    assert.ok(l.traceCols >= MIN_TRACE_COLS,
      `cols=${cols}: trace squeezed to ${l.traceCols} (< ${MIN_TRACE_COLS})`);
  }
});

test('an over-wide request is clamped, not honoured', () => {
  const l = avatarLayout(120, 10_000);
  const region = 120 - Math.floor(120 * TRACE_LEFT_FRACTION);
  assert.ok(l.avatarCols < region, 'avatar must not claim the whole trace region');
  assert.ok(l.avatarCols > 0, 'a 120-col terminal has room for some avatar');
});

test('a narrow terminal SUPPRESSES the avatar rather than shipping a broken layout', () => {
  // 40 cols: trace region is 16, below the readable minimum on its own.
  const l = avatarLayout(40, 18);
  assert.equal(l.avatarCols, 0);
  assert.equal(l.traceRight, 0, 'trace must keep all its columns when no avatar is shown');
});

test('releasing the avatar returns every column to the trace pane', () => {
  // reserveAvatarColumns(null) uses traceRight = 0; assert that is the full-width state.
  const cols = 160;
  const docked = avatarLayout(cols, 24);
  assert.ok(docked.traceRight > 0, 'a docked avatar must reserve something');
  const released = traceSpan(cols, 0);
  const reserved = traceSpan(cols, docked.traceRight);
  assert.ok(released.end > reserved.end, 'releasing must widen the trace pane');
  assert.equal(released.end, cols, 'released trace should reach the screen edge');
});

test('avatarCols is a whole number of columns', () => {
  for (const cols of [80, 100, 133, 167, 201]) {
    const l = avatarLayout(cols, 22);
    assert.ok(Number.isInteger(l.avatarCols), `${l.avatarCols} is not an integer`);
    assert.ok(Number.isInteger(l.avatarStartCol), `${l.avatarStartCol} is not an integer`);
    assert.ok(Number.isInteger(l.traceRight), `${l.traceRight} is not an integer`);
  }
});

test('degenerate widths do not throw or produce negatives', () => {
  for (const cols of [0, 1, -5, NaN, 3]) {
    const l = avatarLayout(cols as number, 20);
    assert.ok(l.avatarCols >= 0 && l.traceRight >= 0 && l.traceCols >= 0,
      `negative geometry for cols=${cols}: ${JSON.stringify(l)}`);
    assert.ok(l.avatarStartCol >= 1, `avatarStartCol must stay a valid ANSI column for cols=${cols}`);
  }
});
