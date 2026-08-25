/**
 * Brain packs — `awsh <pack>` as an alt shell.
 *
 * The rule that decides the whole feature: `awsh gobbonet` must LAUNCH, while
 * `awsh what is gobbonet` must stay an ordinary question. The costs are
 * asymmetric — mistaking a question for a launch drops the user into a session
 * they did not ask for and silently discards what they typed; mistaking a pack
 * name for a question merely answers it. So the discriminator is strict, and
 * both directions are pinned here.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { parseManifest, isUsable, looksLikePackLaunch, selfTest } from '../src/packs.js';

describe('pack manifest parsing', () => {
  test('self-test reports no failures', () => {
    const f = selfTest();
    assert.deepEqual(f, [], `packs self-test failures:\n  ${f.join('\n  ')}`);
  });

  test('reads a block scalar across blank lines, and stops at the next key', () => {
    const y = parseManifest([
      'identity: gobbo',
      'system_prompt: |',
      '  first',
      '',
      '  second',
      'company_name: Aitherium',
    ].join('\n'));
    assert.equal(y.identity, 'gobbo');
    assert.match(y.system_prompt, /first/);
    assert.match(y.system_prompt, /second/, 'a blank line must not end the block');
    assert.doesNotMatch(y.system_prompt, /company_name/, 'block swallowed the next key');
    assert.equal(y.company_name, 'Aitherium');
  });

  test('strips surrounding quotes from a scalar', () => {
    assert.equal(parseManifest('app_name: "GobboNet"').app_name, 'GobboNet');
  });
});

describe('usability — a pack must be able to change behaviour', () => {
  test('no system prompt => NOT usable (refuse rather than pretend)', () => {
    assert.equal(isUsable({ name: 'x', manifest: 'm', root: 'r' }), false);
    assert.equal(isUsable({ name: 'x', manifest: 'm', root: 'r', systemPrompt: '   ' }), false);
  });
  test('a real prompt => usable', () => {
    assert.equal(isUsable({ name: 'x', manifest: 'm', root: 'r', systemPrompt: 'be brief' }), true);
  });
});

describe('launch discriminator', () => {
  test('a single bare word is a launch', () => {
    assert.equal(looksLikePackLaunch(['gobbonet']), 'gobbonet');
    assert.equal(looksLikePackLaunch(['iris']), 'iris');
  });
  test('a question is NOT a launch', () => {
    assert.equal(looksLikePackLaunch(['what', 'is', 'gobbonet']), null);
    assert.equal(looksLikePackLaunch(['what is gobbonet']), null);
  });
  test('a flag is NOT a launch', () => {
    assert.equal(looksLikePackLaunch(['--help']), null);
    assert.equal(looksLikePackLaunch(['-p']), null);
  });
  test('nothing is NOT a launch', () => {
    assert.equal(looksLikePackLaunch([]), null);
  });
  test('a path-ish or odd token is NOT a launch', () => {
    assert.equal(looksLikePackLaunch(['./gobbonet']), null);
    assert.equal(looksLikePackLaunch(['gobbo net']), null);
  });
});
