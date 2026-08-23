/**
 * Aither avatar: every face frame must be column-aligned (all 4 box rows the
 * same display width) and use only single-cell glyphs — a double-width eye or
 * mouth would shear the face (this test caught U+FE35 ︵). We sweep all statuses,
 * a blink tick, and the talking mouth cycle.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { renderAvatar, renderAvatarInline, statusFromTurn, type AvatarState } from '../src/tui/avatar.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// East-Asian-wide / CJK-compat ranges we must never emit in the face.
function hasWideGlyph(s: string): string | null {
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0)!;
    const wide = (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60);
    if (wide) return `U+${cp.toString(16)} (${ch})`;
  }
  return null;
}

// Representative sensations hitting every expression branch.
const SENSATIONS = ['anger', 'frustration', 'affection', 'wonder', 'fatigue', 'melancholy',
  'joy', 'anxiety', 'pride', 'curiosity', 'excitement', 'serenity', 'satisfaction', 'hope'];

const STATES: AvatarState[] = [
  { status: 'idle', affect: { valence: 0 } },
  { status: 'idle', affect: { valence: 0.8, mood: 'cheerful' } },
  { status: 'idle', affect: { valence: -0.6 } },
  { status: 'thinking', affect: { arousal: 0.5 } },
  { status: 'thinking', affect: { arousal: 0.9 } },
  { status: 'talking', affect: {} },
  { status: 'done', affect: { valence: 0.6 } },
  { status: 'error' },
  // every emotion, in idle + done, driven by dominant_sensation:
  ...SENSATIONS.flatMap((s): AvatarState[] => [
    { status: 'idle', affect: { dominant_sensation: s } },
    { status: 'done', affect: { dominant_sensation: s } },
    { status: 'talking', affect: { dominant_sensation: s } },
  ]),
];

describe('Aither avatar', () => {
  test('all frames are column-aligned across states, ticks, and blink/mouth cycles', () => {
    for (const st of STATES) {
      for (let tick = 0; tick < 20; tick++) {   // covers blink (16) + full mouth cycle
        const lines = renderAvatar(st, tick);
        const face = lines.slice(0, 4).map(strip);   // 4 box rows (line 5 is the tag)
        const w = face[0].length;
        for (const l of face) {
          assert.equal(l.length, w, `misaligned row "${l}" (${l.length}≠${w}) for ${st.status}@${tick}`);
          const wide = hasWideGlyph(l);
          assert.equal(wide, null, `double-width glyph ${wide} in "${l}" (${st.status}@${tick})`);
        }
      }
    }
  });

  test('inline variant is single-cell and non-empty', () => {
    for (const st of STATES) {
      const inline = renderAvatarInline(st, 3);
      assert.equal(hasWideGlyph(inline), null, `wide glyph in inline: ${inline}`);
      assert.ok(strip(inline).length > 0);
    }
  });

  test('statusFromTurn maps loop state to expression', () => {
    assert.equal(statusFromTurn({ running: false, streaming: false, errored: false, everRan: false }), 'idle');
    assert.equal(statusFromTurn({ running: true, streaming: false, errored: false, everRan: true }), 'thinking');
    assert.equal(statusFromTurn({ running: true, streaming: true, errored: false, everRan: true }), 'talking');
    assert.equal(statusFromTurn({ running: false, streaming: false, errored: false, everRan: true }), 'done');
    assert.equal(statusFromTurn({ running: true, streaming: true, errored: true, everRan: true }), 'error');
  });
});
