/**
 * What the PROMPT remembers. The screenshot's inline boot ended with
 * `Logged in as David` and a cursor: the reader had to hold "10 down" in working
 * memory across the command they were about to type. The prompt now carries it.
 *
 * State is module-level, so every arm resets it first — a test that inherits facts
 * would pass for the wrong reason.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptFacts, promptLabel, setPromptFacts } from '../src/prompt-state.ts';

test('nothing pending: an empty label, so the prompt stays plain', () => {
  setPromptFacts({});
  assert.equal(promptLabel(), '');
  setPromptFacts({ asks: 0, down: 0, total: 11 });
  assert.equal(promptLabel(), '');
});

test('three asks pending: "3?"', () => {
  setPromptFacts({});
  setPromptFacts({ asks: 3 });
  assert.equal(promptLabel(), '3?');
});

test('ten of eleven services down: "10/11"', () => {
  setPromptFacts({});
  setPromptFacts({ down: 10, total: 11 });
  assert.equal(promptLabel(), '10/11');
});

test('a person waiting outranks the fleet, and one label is never two', () => {
  setPromptFacts({});
  setPromptFacts({ asks: 2, down: 10, total: 11 });
  assert.equal(promptLabel(), '2?');
});

test('a down count with no total cannot be stated as a ratio', () => {
  setPromptFacts({});
  setPromptFacts({ down: 10, total: 0 });
  assert.equal(promptLabel(), '');
});

test('facts are replaced, never merged: a stale count cannot linger', () => {
  setPromptFacts({ asks: 3, down: 4, total: 11 });
  setPromptFacts({ asks: 0 });
  assert.equal(promptLabel(), '');
  assert.deepEqual({ ...promptFacts() }, { asks: 0 });
});
