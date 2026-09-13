/**
 * Test parseClaudeArgs / buildSpawnArgv — the pure half of `aither claude …` and
 * the `/claude` REPL builtin. Pins that the argv handed to `adk claude spawn` uses
 * the runner's OWN flag names (--allow, --budget-usd, --timeout, --goal) and that
 * the documented defaults (Read / 0.25 / 300) survive a round trip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClaudeArgs, buildSpawnArgv, validateClaudeArgs, internalSecretHint,
  DEFAULT_ALLOW, DEFAULT_BUDGET_USD, DEFAULT_TIMEOUT_SEC,
} from '../src/claude-command.js';

test('parseClaudeArgs: bare task words join into one prompt with defaults', () => {
  const p = parseClaudeArgs(['summarize', 'the', 'readme']);
  assert.equal(p.task, 'summarize the readme');
  assert.equal(p.allow, DEFAULT_ALLOW);
  assert.equal(p.budget, DEFAULT_BUDGET_USD);
  assert.equal(p.timeout, DEFAULT_TIMEOUT_SEC);
  assert.equal(p.goal, '');
  assert.deepEqual(p.passthrough, []);
  assert.equal(p.help, false);
});

test('parseClaudeArgs: the four documented flags, before and after the task', () => {
  const p = parseClaudeArgs(['--allow', 'Read,Grep', '--budget', '0.5', 'do', 'x', '--timeout', '60', '--goal', 'g-1']);
  assert.equal(p.task, 'do x');
  assert.equal(p.allow, 'Read,Grep');
  assert.equal(p.budget, '0.5');
  assert.equal(p.timeout, '60');
  assert.equal(p.goal, 'g-1');
});

test('parseClaudeArgs: --name=value spelling', () => {
  const p = parseClaudeArgs(['--budget=1.25', '--allow=Read', 'task']);
  assert.equal(p.budget, '1.25');
  assert.equal(p.allow, 'Read');
  assert.equal(p.task, 'task');
});

test('parseClaudeArgs: unknown flags pass through verbatim; --no-wait eats no task word', () => {
  const p = parseClaudeArgs(['--model', 'haiku', '--no-wait', 'run', 'it']);
  assert.deepEqual(p.passthrough, ['--model', 'haiku', '--no-wait']);
  assert.equal(p.task, 'run it');
});

test('parseClaudeArgs: --help anywhere sets help', () => {
  assert.equal(parseClaudeArgs(['--help']).help, true);
  assert.equal(parseClaudeArgs(['task', '-h']).help, true);
});

test('parseClaudeArgs: -- ends flag parsing', () => {
  const p = parseClaudeArgs(['--allow', 'Read', '--', '--not-a-flag', 'word']);
  assert.equal(p.task, '--not-a-flag word');
  assert.deepEqual(p.passthrough, []);
});

test('buildSpawnArgv: uses the runner\'s exact flag names and maps --budget to --budget-usd', () => {
  const argv = buildSpawnArgv(parseClaudeArgs(['--budget', '0.5', '--goal', 'g', 'hello', 'world']));
  assert.deepEqual(argv, [
    '-m', 'adk.cli', 'claude', 'spawn',
    '--task', 'hello world',
    '--allow', 'Read',
    '--budget-usd', '0.5',
    '--timeout', '300',
    '--goal', 'g',
  ]);
  // No flag the runner does not declare (`adk claude spawn --help`, 2026-09-02).
  const known = new Set(['--task', '--task-file', '--allow', '--deny', '--model', '--append-system-prompt',
    '--mcp-config', '--cwd', '--timeout', '--budget-usd', '--account', '--resume', '--goal', '--url', '--token', '--no-wait']);
  for (const a of argv.filter(x => x.startsWith('--'))) assert.ok(known.has(a), `unknown runner flag ${a}`);
  assert.ok(!argv.includes('--budget'), 'the short --budget must never reach argparse');
});

test('buildSpawnArgv: omits --goal when empty, appends passthrough last', () => {
  const argv = buildSpawnArgv(parseClaudeArgs(['--cwd', 'C:/x', 't']));
  assert.ok(!argv.includes('--goal'));
  assert.deepEqual(argv.slice(-2), ['--cwd', 'C:/x']);
});

test('validateClaudeArgs: rejects a non-numeric budget and a non-integer timeout', () => {
  assert.match(validateClaudeArgs(parseClaudeArgs(['--budget', 'lots', 't'])), /--budget/);
  assert.match(validateClaudeArgs(parseClaudeArgs(['--timeout', '1.5', 't'])), /--timeout/);
  assert.match(validateClaudeArgs(parseClaudeArgs(['--timeout', '0', 't'])), /--timeout/);
  assert.equal(validateClaudeArgs(parseClaudeArgs(['t'])), '');
});

test('internalSecretHint: names the synced token file and repo-root .env when unset, silent when set', () => {
  const hint = internalSecretHint({});
  assert.match(hint, /AITHER_INTERNAL_SECRET/);
  // The daemon auto-syncs its bearer to this file, so a bare shell resolves it.
  assert.match(hint, /claude-runner\/token/);
  // The runner reads the secret from the repo-root .env (the old hint named the
  // wrong env file, which carried no such key).
  assert.match(hint, /repo-root \.env/);
  assert.equal(internalSecretHint({ AITHER_INTERNAL_SECRET: 'x' }), '');
  assert.equal(internalSecretHint({ AITHER_CLAUDE_RUNNER_TOKEN: 'x' }), '');
});
