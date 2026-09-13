/**
 * Test the pure half of `aither backend …` / `/backend` — arg parsing, profile
 * loading/merging, and token resolution. No process is spawned here; the launch
 * itself (spawn('claude', ...)) is exercised only by hand, same as claude-command's
 * spawn path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseBackendArgs, loadProfiles, resolveToken, ALL_VARS,
} from '../src/backend-command.js';

test('parseBackendArgs: defaults to help on no args', () => {
  const p = parseBackendArgs([]);
  assert.equal(p.sub, 'help');
  assert.equal(p.help, true);
});

test('parseBackendArgs: list/use/status recognized, unknown sub falls back to help', () => {
  assert.equal(parseBackendArgs(['list']).sub, 'list');
  assert.equal(parseBackendArgs(['status']).sub, 'status');
  const u = parseBackendArgs(['use', 'deepseek']);
  assert.equal(u.sub, 'use');
  assert.equal(u.profileName, 'deepseek');
  assert.equal(parseBackendArgs(['bogus']).sub, 'help');
});

test('parseBackendArgs: --help anywhere sets help without changing sub away from a real one', () => {
  const p = parseBackendArgs(['list', '--help']);
  assert.equal(p.sub, 'list');
  assert.equal(p.help, true);
});

test('loadProfiles: with no file present, only the built-in anthropic profile exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awsh-backend-test-'));
  try {
    const missing = join(dir, 'nope', 'profiles.json');
    const profiles = loadProfiles(missing);
    assert.deepEqual(Object.keys(profiles), ['anthropic']);
    assert.equal(profiles.anthropic.vars, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadProfiles: merges a real file onto the built-in default, and strips _README', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awsh-backend-test-'));
  try {
    const path = join(dir, 'profiles.json');
    writeFileSync(path, JSON.stringify({
      _README: ['ignore me'],
      deepseek: {
        comment: 'test profile',
        token_env: 'TEST_DEEPSEEK_KEY',
        vars: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_MODEL: 'deepseek-v4-flash[1m]' },
      },
    }));
    const profiles = loadProfiles(path);
    assert.ok(profiles.anthropic, 'built-in anthropic survives a merge');
    assert.ok(profiles.deepseek, 'file profile is present');
    assert.equal((profiles as any)._README, undefined, '_README must not be treated as a profile');
    assert.equal(profiles.deepseek.vars?.ANTHROPIC_MODEL, 'deepseek-v4-flash[1m]');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadProfiles: unreadable JSON falls back to the built-in default rather than throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awsh-backend-test-'));
  try {
    const path = join(dir, 'profiles.json');
    writeFileSync(path, '{ not valid json');
    const profiles = loadProfiles(path);
    assert.deepEqual(Object.keys(profiles), ['anthropic']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveToken: token_env present in env resolves; absent throws naming the var', () => {
  const p = { token_env: 'AWSH_TEST_TOKEN' };
  assert.equal(resolveToken(p, { AWSH_TEST_TOKEN: 'secret-value' }), 'secret-value');
  assert.throws(() => resolveToken(p, {}), /AWSH_TEST_TOKEN/);
});

test('resolveToken: token_file reads and trims; missing file throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awsh-backend-test-'));
  try {
    const file = join(dir, 'token.txt');
    writeFileSync(file, '  a-token-value  \n');
    assert.equal(resolveToken({ token_file: file }, {}), 'a-token-value');
    assert.throws(() => resolveToken({ token_file: join(dir, 'nope.txt') }, {}), /token_file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveToken: a profile with neither token_env nor token_file returns undefined (the anthropic case)', () => {
  assert.equal(resolveToken({}, {}), undefined);
});

test('ALL_VARS: covers every var the AitherOS monorepo\'s own deepseek/kimi-k3 profiles set', () => {
  // Regression pin: these are the exact keys the live tools/claude-backend/profiles.json
  // ships for deepseek and kimi-k3. If a future profile sets a var not in this list,
  // `use` warns (see backend-command.ts) but the WARN itself is only reachable if this
  // list stays in sync with what real profiles actually need.
  const required = [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'ENABLE_TOOL_SEARCH',
  ];
  for (const v of required) assert.ok((ALL_VARS as readonly string[]).includes(v), `ALL_VARS missing ${v}`);
});
