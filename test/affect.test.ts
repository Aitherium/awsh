/**
 * Tests for the affect poller: JSON parsing with snake_case → camelCase conversion,
 * defaults, and the Affect interface structure. Network calls are not tested
 * (the poller is never started during tests).
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { parseAffect, type Affect } from '../src/tui/affect.js';

describe('affect poller', () => {
  test('parseAffect: full response with all fields', () => {
    const json = {
      valence: 0.5,
      arousal: 0.7,
      confidence: 0.9,
      openness: 0.3,
      existential_depth: 0.4,
      dominant_sensation: 'curiosity',
      active_sensation_count: 3,
      mood: 'thoughtful',
      prompt_modifier: 'analytical',
    };

    const result = parseAffect(json);
    assert.equal(result.valence, 0.5);
    assert.equal(result.arousal, 0.7);
    assert.equal(result.confidence, 0.9);
    assert.equal(result.openness, 0.3);
    assert.equal(result.existentialDepth, 0.4, 'snake_case existential_depth → camelCase');
    assert.equal(result.dominantSensation, 'curiosity', 'snake_case dominant_sensation → camelCase');
    assert.equal(result.activeCount, 3, 'snake_case active_sensation_count → camelCase');
    assert.equal(result.mood, 'thoughtful');
    assert.equal(result.promptModifier, 'analytical', 'snake_case prompt_modifier → camelCase');
  });

  test('parseAffect: sparse object with defaults', () => {
    const json = {
      valence: -0.2,
      mood: 'melancholy',
    };

    const result = parseAffect(json);
    assert.equal(result.valence, -0.2);
    assert.equal(result.arousal, 0, 'missing arousal defaults to 0');
    assert.equal(result.confidence, 0, 'missing confidence defaults to 0');
    assert.equal(result.openness, 0, 'missing openness defaults to 0');
    assert.equal(result.existentialDepth, 0, 'missing existential_depth defaults to 0');
    assert.equal(result.dominantSensation, '', 'missing dominant_sensation defaults to ""');
    assert.equal(result.activeCount, 0, 'missing active_sensation_count defaults to 0');
    assert.equal(result.mood, 'melancholy');
    assert.equal(result.promptModifier, '', 'missing prompt_modifier defaults to ""');
  });

  test('parseAffect: empty object gets all defaults', () => {
    const json = {};

    const result = parseAffect(json);
    assert.equal(result.valence, 0);
    assert.equal(result.arousal, 0);
    assert.equal(result.confidence, 0);
    assert.equal(result.openness, 0);
    assert.equal(result.existentialDepth, 0);
    assert.equal(result.dominantSensation, '');
    assert.equal(result.activeCount, 0);
    assert.equal(result.mood, '');
    assert.equal(result.promptModifier, '');
  });

  test('parseAffect: null or undefined input is safe', () => {
    const result1 = parseAffect(null);
    const result2 = parseAffect(undefined);
    assert.equal(result1.valence, 0);
    assert.equal(result2.valence, 0);
  });

  test('parseAffect: type coercion for numbers', () => {
    const json = {
      valence: '0.5', // string instead of number
      arousal: 0.7,
      confidence: '0.9',
    };

    const result = parseAffect(json);
    // Non-number types should be rejected and default to 0
    assert.equal(result.valence, 0, 'string valence is not a number, defaults to 0');
    assert.equal(result.arousal, 0.7);
    assert.equal(result.confidence, 0, 'string confidence defaults to 0');
  });

  test('parseAffect: type coercion for strings', () => {
    const json = {
      mood: 123, // number instead of string
      dominant_sensation: true, // boolean instead of string
      prompt_modifier: 'valid_string',
    };

    const result = parseAffect(json);
    assert.equal(result.mood, '', 'non-string mood defaults to ""');
    assert.equal(result.dominantSensation, '', 'non-string dominant_sensation defaults to ""');
    assert.equal(result.promptModifier, 'valid_string');
  });

  test('parseAffect: all numeric fields stay within reasonable ranges', () => {
    const json = {
      valence: -1.0,
      arousal: 1.0,
      confidence: 0.0,
      openness: 0.5,
      existential_depth: 1.0,
      active_sensation_count: 10,
    };

    const result = parseAffect(json);
    assert.equal(result.valence, -1.0);
    assert.equal(result.arousal, 1.0);
    assert.equal(result.confidence, 0.0);
    assert.equal(result.openness, 0.5);
    assert.equal(result.existentialDepth, 1.0);
    assert.equal(result.activeCount, 10);
  });

  test('parseAffect returns a valid Affect interface', () => {
    const json = {
      valence: 0.25,
      arousal: 0.5,
      confidence: 0.8,
      openness: 0.3,
      existential_depth: 0.6,
      dominant_sensation: 'wonder',
      active_sensation_count: 2,
      mood: 'curious',
      prompt_modifier: 'exploratory',
    };

    const result: Affect = parseAffect(json);

    // All Affect fields should exist and be the right type
    assert.equal(typeof result.valence, 'number');
    assert.equal(typeof result.arousal, 'number');
    assert.equal(typeof result.confidence, 'number');
    assert.equal(typeof result.openness, 'number');
    assert.equal(typeof result.existentialDepth, 'number');
    assert.equal(typeof result.dominantSensation, 'string');
    assert.equal(typeof result.activeCount, 'number');
    assert.equal(typeof result.mood, 'string');
    assert.equal(typeof result.promptModifier, 'string');
  });
});
