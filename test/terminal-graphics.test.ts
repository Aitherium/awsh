/**
 * Tests for awsh 2.0 multi-protocol terminal graphics, bust cropping, fixed half-block
 * vertical coverage, trace-hidden avatar layout, avatar CLI parsing, and multi-harness agent args.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePortraitCrop,
  decodePng,
  encodePng,
  renderHalfBlock,
  type PngImage,
} from '../src/tui/portrait.js';
import {
  clearKittyImage,
  detectGraphicsProtocol,
  encodeITerm2Png,
  encodeKittyPng,
  encodeSixelRgba,
  listAvailableAvatars,
  renderAvatarImage,
  resolveAvatarDir,
} from '../src/tui/terminal-graphics.js';
import {
  AVATAR_TOP_ROW,
  avatarLayoutWhenTraceHidden,
  MIN_OUTPUT_COLS,
} from '../src/tui/screen.js';
import { shouldAutoDock } from '../src/tui/avatar-autodock.js';
import { parseAvatarArgs } from '../src/avatar-command.js';
import { agentSessionBody, parseAgentArgs } from '../src/agent-repl.js';

function makeTwoBandImage(w: number, h: number): PngImage {
  // Top half pure red, bottom half pure blue — proves the old scaleY*2 bottom-50%-clip bug is dead.
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (y < h / 2) {
        rgba[o] = 240; rgba[o + 1] = 20; rgba[o + 2] = 20; rgba[o + 3] = 255;
      } else {
        rgba[o] = 20; rgba[o + 1] = 40; rgba[o + 2] = 240; rgba[o + 3] = 255;
      }
    }
  }
  return { width: w, height: h, rgba };
}

describe('awsh 2.0 portrait codec & half-block fidelity', () => {
  test('renderHalfBlock covers the full vertical extent (bottom half is NOT clipped)', () => {
    const img = makeTwoBandImage(32, 32);
    const lines = renderHalfBlock(img.rgba, img.width, img.height, 16);
    assert.equal(lines.length, 8);
    // Top line must contain red truecolor RGB; bottom line must contain blue truecolor RGB.
    assert.match(lines[0], /38;2;240;20;20/);
    assert.match(lines[lines.length - 1], /38;2;20;40;240/);
    assert.match(lines[lines.length - 1], /48;2;20;40;240/);
  });

  test('encodePng -> decodePng round-trip preserves RGBA pixels', () => {
    const img = makeTwoBandImage(12, 16);
    const buf = encodePng(img);
    const dec = decodePng(buf);
    assert.equal(dec.width, 12);
    assert.equal(dec.height, 16);
    assert.deepEqual(dec.rgba, img.rgba);
  });

  test('computePortraitCrop frames head+shoulders on tall full-body portraits', () => {
    // Tall 100x200 opaque character centered in canvas
    const rgba = new Uint8Array(100 * 200 * 4);
    for (let y = 20; y < 190; y++) {
      for (let x = 25; x < 75; x++) {
        const o = (y * 100 + x) * 4;
        rgba[o] = 200; rgba[o + 1] = 150; rgba[o + 2] = 120; rgba[o + 3] = 255;
      }
    }
    const bust = computePortraitCrop({ width: 100, height: 200, rgba }, 'bust');
    const full = computePortraitCrop({ width: 100, height: 200, rgba }, 'full');
    assert.equal(full.height, 200);
    assert.ok(bust.height < 140, `expected bust crop < 140px tall, got ${bust.height}`);
    assert.ok(bust.y <= 20, `expected bust crop to start at/above top of head (y<=20), got ${bust.y}`);
  });
});

describe('awsh 2.0 multi-protocol terminal graphics', () => {
  test('detectGraphicsProtocol identifies Kitty, Ghostty, WezTerm, iTerm2, Sixel, tmux, and explicit overrides', () => {
    assert.equal(detectGraphicsProtocol({ KITTY_WINDOW_ID: '1' }).protocol, 'kitty');
    assert.equal(detectGraphicsProtocol({ GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty' }).protocol, 'kitty');
    assert.equal(detectGraphicsProtocol({ TERM_PROGRAM: 'WezTerm' }).protocol, 'kitty');
    assert.equal(detectGraphicsProtocol({ TERM_PROGRAM: 'iTerm.app' }).protocol, 'iterm2');
    assert.equal(detectGraphicsProtocol({ TERM: 'foot' }).protocol, 'sixel');
    assert.equal(detectGraphicsProtocol({ WT_SESSION: 'abc', AWSH_WT_SIXEL: '1' }).protocol, 'sixel');
    assert.equal(detectGraphicsProtocol({ WT_SESSION: 'abc' }).protocol, 'halfblock');
    // Inside tmux without passthrough, always safe halfblock
    assert.equal(detectGraphicsProtocol({ KITTY_WINDOW_ID: '1', TMUX: '/tmp/tmux' }).protocol, 'halfblock');
    // Explicit override always wins
    assert.equal(detectGraphicsProtocol({ AWSH_AVATAR_PROTOCOL: 'sixel' }).protocol, 'sixel');
    assert.equal(detectGraphicsProtocol({}, 'kitty').protocol, 'kitty');
  });

  test('Kitty, iTerm2, and Sixel encoders emit valid protocol framing', () => {
    const img = makeTwoBandImage(16, 16);
    const png = encodePng(img);

    const kitty = encodeKittyPng(png, { cols: 20, rows: 10, imageId: 4242, noCursorMove: true });
    assert.ok(kitty.startsWith('\x1b_Ga=T,f=100,q=2,c=20,r=10,i=4242,C=1,m='));
    assert.ok(kitty.endsWith('\x1b\\'));
    assert.equal(clearKittyImage(4242), '\x1b_Ga=d,d=I,i=4242,q=2;\x1b\\');

    const iterm = encodeITerm2Png(png, 20, 10);
    assert.ok(iterm.startsWith('\x1b]1337;File=inline=1;'));
    assert.ok(iterm.endsWith('\x07'));

    const sixel = encodeSixelRgba(img);
    assert.ok(sixel.startsWith('\x1bP0;1;0q"1;1;16;16'));
    assert.ok(sixel.endsWith('\x1b\\'));

    const rendered = renderAvatarImage(img, { cols: 16, protocol: 'kitty', imageId: 7 });
    assert.equal(rendered.protocol, 'kitty');
    assert.ok(rendered.nativePayload && rendered.nativePayload.includes('i=7'));
    assert.ok(rendered.lines.length > 0);
  });

  test('bundled avatar assets are discoverable out of the box', () => {
    const avatars = listAvailableAvatars();
    assert.ok(avatars.includes('aither'), `expected 'aither' in ${avatars.join(', ')}`);
    assert.ok(resolveAvatarDir('aither') !== null);
  });
});

describe('awsh 2.0 TUI docking geometry & CLI ergonomics', () => {
  test('docked avatar starts below row 1 status bar and never overlaps output when trace is hidden', () => {
    assert.equal(AVATAR_TOP_ROW, 2);
    for (let cols = 40; cols <= 300; cols += 5) {
      const l = avatarLayoutWhenTraceHidden(cols, 24);
      if (l.avatarCols === 0) continue;
      assert.ok(l.traceCols >= MIN_OUTPUT_COLS, `cols=${cols} output squeezed to ${l.traceCols}`);
      assert.ok(l.avatarStartCol - 1 >= cols - l.traceRight, 'avatar overlapped output pane');
      assert.ok(l.avatarStartCol - 1 + l.avatarCols <= cols, 'avatar ran past screen edge');
    }
  });

  test('shouldAutoDock recognizes Ghostty/Kitty/WezTerm/WT at >= 90 cols', () => {
    assert.equal(shouldAutoDock({ GHOSTTY_RESOURCES_DIR: '/x' }, 92), true);
    assert.equal(shouldAutoDock({ KITTY_WINDOW_ID: '1' }, 92), true);
    assert.equal(shouldAutoDock({ COLORTERM: 'truecolor' }, 80), false);
    assert.equal(shouldAutoDock({ AWSH_AVATAR: '0', COLORTERM: 'truecolor' }, 160), false);
  });

  test('parseAvatarArgs handles show, list, use, protocol, crop, demo, sync', () => {
    assert.equal(parseAvatarArgs(['list']).sub, 'list');
    assert.deepEqual(parseAvatarArgs(['use', 'bunny']).target, 'bunny');
    const show = parseAvatarArgs(['show', 'aither', '--emotion', 'happy', '--protocol', 'kitty', '--cols', '30', '--full']);
    assert.equal(show.sub, 'show');
    assert.equal(show.target, 'aither');
    assert.equal(show.emotion, 'happy');
    assert.equal(show.protocol, 'kitty');
    assert.equal(show.cols, 30);
    assert.equal(show.crop, 'full');
  });

  test('parseAgentArgs & agentSessionBody support multi-harness (antigravity, codex, gemini, claude)', () => {
    const ag = parseAgentArgs(['aither', '--harness', 'antigravity', '-p', 'fix bug'], '/tmp/repo');
    assert.equal(ag.harness, 'antigravity');
    const body = agentSessionBody(ag);
    assert.equal(body.harness, 'antigravity');
    assert.equal(body.agent, 'aither');
    assert.equal(body.extra_args, undefined);

    const claude = parseAgentArgs(['lyra'], '/tmp/repo');
    assert.equal(claude.harness, 'claude');
    assert.deepEqual(agentSessionBody(claude).extra_args, ['--agent', 'lyra']);
  });
});
