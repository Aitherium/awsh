/**
 * The terminal fairy: the agent's name in its palette colour, and nothing but the bare
 * text where colour cannot land (NO_COLOR, TERM=dumb, a pipe).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_FAIRIES } from '../src/agent-fairies.generated.ts';
import { colorEnabled, fairyFor, fairyTag, normalizeAgent, truecolor } from '../src/agent-fairy.ts';

test('every palette agent resolves to its own label and colour', () => {
  for (const [key, entry] of Object.entries(AGENT_FAIRIES.agents)) {
    const f = fairyFor(entry.label);
    assert.equal(f.agent, key);
    assert.equal(f.label, entry.label);
    assert.equal(f.color, entry.color);
    assert.equal(f.known, true);
  }
});

test('aliases, @mentions and compound names resolve like the desk does', () => {
  assert.equal(normalizeAgent('demi'), 'demiurge');
  assert.equal(normalizeAgent('@Lyra'), 'lyra');
  assert.equal(normalizeAgent('aither-atlas'), 'aither', 'the first word that names an agent wins');
  assert.equal(normalizeAgent('nobody'), '');
});

test('an unknown agent keeps its own name in the default colour', () => {
  const f = fairyFor('sample-agent');
  assert.equal(f.known, false);
  assert.equal(f.label, 'sample-agent');
  assert.equal(f.color, AGENT_FAIRIES.agents.aither.color);
  assert.equal(fairyFor('').label, 'Aither');
});

test('truecolor is the exact palette hex as 24-bit SGR', () => {
  assert.equal(truecolor('#8b5cf6'), '\x1b[38;2;139;92;246m');
  assert.equal(
    fairyTag('lyra', { color: true }),
    '\x1b[38;2;139;92;246m✦ Lyra\x1b[39m',
  );
});

test('no colour: the bare tag, no escape bytes at all', () => {
  assert.equal(fairyTag('demiurge', { color: false }), '✦ Demiurge');
  assert.doesNotMatch(fairyTag('iris', { color: false }), /\x1b/);
});

test('colour lands only on a TTY with NO_COLOR unset and TERM not dumb', () => {
  const tty = { isTTY: true };
  assert.equal(colorEnabled(tty, {}), true);
  assert.equal(colorEnabled(tty, { NO_COLOR: '1' }), false);
  assert.equal(colorEnabled(tty, { NO_COLOR: '' }), true, 'no-color.org: only a non-empty value disables');
  assert.equal(colorEnabled(tty, { TERM: 'dumb' }), false);
  assert.equal(colorEnabled({ isTTY: false }, {}), false);
  assert.equal(colorEnabled(undefined, {}), false);
});
