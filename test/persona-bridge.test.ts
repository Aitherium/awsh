/**
 * Regression tests for the two defects that made /persona inert against a real Persona
 * build. Both were invisible to every existing check: the code compiled, the health probe
 * passed, and the command printed a plausible error or an empty list.
 *
 *  1. The MCP request advertised only `application/json`. Persona enforces the
 *     Streamable-HTTP rule and answers 406 "must accept both application/json and
 *     text/event-stream" — so EVERY subcommand failed.
 *  2. `list_characters` returns `{active, characters[]}`, but the caller asked
 *     `Array.isArray(parsed)` and fell back to `[]` — an empty roster that reads as
 *     "no characters installed" rather than as a parse bug. (71 are installed.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMcpBody,
  normalizeCharacterList,
  normalizeAnimationName,
  isValidAnimation,
  mergeAnimationList,
  PERSONA_ANIMATIONS,
} from '../src/persona-bridge.js';

test('parseMcpBody handles plain JSON', () => {
  const out = parseMcpBody('application/json', '{"result":{"ok":true}}');
  assert.deepEqual(out, { result: { ok: true } });
});

test('parseMcpBody handles an SSE-framed reply — the transport may pick either shape', () => {
  const sse = 'event: message\ndata: {"result":{"ok":true}}\n\n';
  assert.deepEqual(parseMcpBody('text/event-stream', sse), { result: { ok: true } });
});

test('parseMcpBody takes the LAST data frame, past keepalives and comments', () => {
  const sse = [': keepalive', 'data: {"n":1}', '', 'event: message', 'data: {"n":2}', ''].join('\n');
  assert.deepEqual(parseMcpBody('text/event-stream; charset=utf-8', sse), { n: 2 });
});

test('parseMcpBody throws on an empty event-stream rather than returning undefined', () => {
  assert.throws(() => parseMcpBody('text/event-stream', ': keepalive\n\n'), /empty event-stream/);
});

test('normalizeCharacterList reads the OBJECT shape Persona actually returns', () => {
  // Verbatim shape measured from a live Persona 0.1.0-beta.0 on 2026-07-29.
  const live = { active: 'kunoichi-100-triangle-meshes', characters: ['mermaid', 'orion', 'helen'] };
  const out = normalizeCharacterList(live);
  assert.equal(out.active, 'kunoichi-100-triangle-meshes');
  assert.deepEqual(out.characters, ['mermaid', 'orion', 'helen']);
});

test('normalizeCharacterList still accepts a bare array', () => {
  const out = normalizeCharacterList(['a', 'b']);
  assert.equal(out.active, null);
  assert.deepEqual(out.characters, ['a', 'b']);
});

test('normalizeCharacterList never throws on junk, and never invents entries', () => {
  for (const junk of [null, undefined, 42, 'nope', {}, { characters: 'not-a-list' }]) {
    const out = normalizeCharacterList(junk as any);
    assert.deepEqual(out.characters, []);
    assert.equal(out.active, null);
  }
});

test('normalizeCharacterList drops non-string entries', () => {
  const out = normalizeCharacterList({ active: 7, characters: ['ok', 3, null, 'fine'] });
  assert.deepEqual(out.characters, ['ok', 'fine']);
  assert.equal(out.active, null);
});

test('animation names are lowercased/hyphenated for the MCP tool schema', () => {
  // The /events path is UPPERCASE (FINGER_GUN); the MCP tool enum is lowercase
  // (finger-gun). Sending the wrong one is rejected by the schema.
  assert.equal(normalizeAnimationName('FINGER_GUN'), 'finger-gun');
  assert.equal(normalizeAnimationName('Dance'), 'dance');
  assert.equal(normalizeAnimationName('  HAPPY  '), 'happy');
});

test('FILE: animation names keep their case — .vrma filenames are case-sensitive', () => {
  assert.equal(normalizeAnimationName('FILE:MyPose.vrma'), 'FILE:MyPose.vrma');
  assert.equal(normalizeAnimationName('file:MyPose.vrma'), 'FILE:MyPose.vrma');
});

test('every /events animation name maps to a valid MCP tool name', () => {
  // Guards the two-layer split: if someone adds a clip to one vocabulary only, this fails.
  const mcpEnum = ['idle', 'greeting', 'talk', 'happy', 'finger-gun', 'dance'];
  for (const a of PERSONA_ANIMATIONS) {
    assert.ok(mcpEnum.includes(normalizeAnimationName(a)), `${a} has no MCP equivalent`);
  }
  assert.equal(PERSONA_ANIMATIONS.length, mcpEnum.length);
});

test('an unknown animation is rejected CLIENT-side — Persona accepts it and plays nothing', () => {
  // Measured live 2026-07-29: play_animation with a junk name returned success. So the
  // shell must reject it, or /persona anim <typo> reports "Played ✓" and does nothing.
  assert.equal(isValidAnimation('definitely-not-a-clip'), false);
  assert.equal(isValidAnimation(''), false);
  assert.equal(isValidAnimation('happy!'), false);
  assert.equal(isValidAnimation('../../etc/passwd'), false);
});

test('every real clip name passes validation, in any case the user might type', () => {
  for (const a of ['dance', 'DANCE', 'finger-gun', 'FINGER_GUN', 'idle', 'Greeting', 'talk', 'happy']) {
    assert.ok(isValidAnimation(a), `${a} should be valid`);
  }
  assert.ok(isValidAnimation('FILE:my-pose.vrma'));
  assert.equal(isValidAnimation('FILE:my-pose.txt'), false);
});

// ── list_animations discovery ────────────────────────────────────────────────
// `listAnimations` was accepted by Persona's MCP constructor and passed in by main.cjs,
// but no tool exposed it — so FILE:<name>.vrma playback worked while `/persona anims`
// could only ever print the 6 built-ins.
test('mergeAnimationList surfaces installed .vrma packs alongside the built-ins', () => {
  const live = ['idle', 'dance', 'FILE:wave.vrma', 'FILE:MyPose.vrma'];
  const out = mergeAnimationList(live);
  assert.ok(out.includes('FILE:wave.vrma'), 'custom pack missing');
  assert.ok(out.includes('FILE:MyPose.vrma'), 'case-sensitive pack name lost');
  for (const b of ['idle', 'greeting', 'talk', 'happy', 'finger-gun', 'dance']) {
    assert.ok(out.includes(b), `built-in ${b} missing`);
  }
});

test('mergeAnimationList falls back to the built-ins on an older Persona', () => {
  // No list_animations tool -> null. Printing NOTHING would be worse than the built-ins.
  for (const junk of [null, undefined, 'nope', 42, {}]) {
    const out = mergeAnimationList(junk as any);
    assert.equal(out.length, 6, `expected the 6 built-ins for ${JSON.stringify(junk)}`);
    assert.ok(out.includes('dance'));
  }
});

test('mergeAnimationList drops entries play_animation would reject', () => {
  const out = mergeAnimationList(['dance', 'FILE:ok.vrma', 'FILE:bad.txt', 'not-a-clip', 7, null]);
  assert.ok(out.includes('FILE:ok.vrma'));
  assert.ok(!out.includes('FILE:bad.txt'), 'non-.vrma must not be offered');
  assert.ok(!out.includes('not-a-clip'), 'unknown clip must not be offered');
  // Everything offered must be playable — otherwise the list itself is a silent no-op.
  for (const a of out) assert.ok(isValidAnimation(a), `${a} is listed but not playable`);
});

test('mergeAnimationList de-duplicates and keeps built-ins first', () => {
  const out = mergeAnimationList(['dance', 'DANCE', 'dance', 'FILE:x.vrma']);
  assert.equal(out.filter(a => a === 'dance').length, 1, 'dance duplicated');
  assert.equal(out[0], 'idle', 'built-in order not stable');
  assert.equal(out[out.length - 1], 'FILE:x.vrma', 'custom packs should come last');
});
