/**
 * Practical decisions go to the reasoning model with thinking on.
 *
 * Measured 2026-10-03 on the live gateway: aither-orchestrator told the owner
 * to WALK to the car wash 6/6 (with or without thinking); the reasoning route with
 * thinking said "drive - the car has to be there" 2/2. The router must catch the
 * decisions and leave every other omnibox line on the ~1 s model.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { isDeliberateQuestion, DELIBERATE_MODEL, DELIBERATE_FALLBACK, DECISION_FRAMING } from '../src/omnibox.js';

describe('isDeliberateQuestion', () => {
  for (const line of [
    'should i drive my car to the car wash or walk?',
    'can I wash my car if I walk?',
    'how can I wash my car if I leave it at home and walk to the car wash',
    'is it better to rent or buy a GPU for my lab',
    'my phone is dead, should I call or text my friend?',
  ]) {
    test(`routes a decision: ${line}`, () => assert.equal(isDeliberateQuestion(line), true));
  }

  for (const line of [
    'how many rs are in strawberry',
    'where is my car',
    'tell me a joke',
    'what is in the news today',
    'can i',
    'gti status',
    'tell me about oranges or apples',  // "or" without a question mark or a first person
  ]) {
    test(`stays fast: ${line}`, () => assert.equal(isDeliberateQuestion(line), false));
  }

  test('routes to DeepSeek V4 Flash (4/4 in ~2 s), falls back to the local pool', () => {
    assert.equal(DELIBERATE_MODEL, 'aither-deepseek');
    assert.equal(DELIBERATE_FALLBACK, 'aither-reasoning');
  });
});

describe('DECISION_FRAMING', () => {
  test('does not tell the model it is at a shell prompt (it role-played "bash: command not found")', () => {
    assert.doesNotMatch(DECISION_FRAMING, /shell prompt|command was expected/i);
  });
  test('carries the where-must-things-be constraint, without a worked example to parrot', () => {
    assert.match(DECISION_FRAMING, /physically be where/);
    assert.doesNotMatch(DECISION_FRAMING, /car|bike|walk/i);
  });
});
