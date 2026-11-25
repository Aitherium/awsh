/**
 * Claude Code hooks in the awsh agent REPL.
 *
 * What must hold (measured 2026-11-09: ten SessionStart hooks ran on a harness
 * session and the REPL showed none of them): a failed or blocking hook prints at
 * once with its name, exit code and what it said; successes fold into one line per
 * turn; nothing about hooks leaks as raw notice noise; /hooks reports the session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HookTally, formatHookFailure, hookOutcome } from '../src/hook-events.js';
import { runAgentRepl, runTurn } from '../src/agent-repl.js';

const resp = (over: Record<string, unknown> = {}) => ({
  kind: 'notice', text: 'system/hook_response',
  data: { payload: { subtype: 'hook_response', hook_name: 'SessionStart:startup', hook_event: 'SessionStart',
    outcome: 'success', exit_code: '0', stdout: '', stderr: '', output: '', ...over } },
});
const started = { kind: 'notice', text: 'system/hook_started', data: { payload: { subtype: 'hook_started' } } };

test('hookOutcome reads success, failure and exit-2 block', () => {
  assert.deepEqual(hookOutcome(resp()), { event: 'SessionStart', name: 'SessionStart:startup', ok: true, exitCode: 0, outcome: 'success', detail: '' });
  const blocked = hookOutcome(resp({ hook_name: 'Stop', hook_event: 'Stop', outcome: 'error', exit_code: '2', stderr: '\nself-review: name one weakness\nmore' }))!;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.detail, 'self-review: name one weakness');
  assert.equal(formatHookFailure(blocked), '! hook Stop blocked (exit 2): self-review: name one weakness');
  assert.equal(hookOutcome(resp({ exit_code: '1' }))!.ok, false);
  assert.equal(hookOutcome({ kind: 'text.delta', text: 'x' }), null);
  assert.equal(hookOutcome(started), null);
});

test('HookTally folds successes per event and keeps failures', () => {
  const t = new HookTally();
  for (let i = 0; i < 10; i++) t.add(hookOutcome(resp())!);
  t.add(hookOutcome(resp({ hook_name: 'Stop', hook_event: 'Stop', exit_code: '2', outcome: 'error' }))!);
  assert.equal(t.summary(), 'hooks: SessionStart 10 ok · Stop 0 ok, 1 failed');
  assert.equal(t.failures.length, 1);
  assert.equal(t.size, 11);
  assert.equal(new HookTally().summary(), '');
});

function api(events: any[]) {
  return async <T>(path: string): Promise<T> => {
    if (path.endsWith('/submit')) return { ok: true } as T;
    if (path.includes('/events')) return { state: 'idle', events } as T;
    if (path === '/sessions') return { id: 's1' } as T;
    throw new Error(path);
  };
}

test('runTurn: one summary line for successes, failures loud, no hook noise', async () => {
  let out = '';
  const events = [
    { seq: 1, ...started }, { seq: 2, ...resp() }, { seq: 3, ...resp() },
    { seq: 4, kind: 'session.ready', data: {} },
    { seq: 5, kind: 'text.delta', text: 'hi' },
    { seq: 6, ...resp({ hook_name: 'Stop', hook_event: 'Stop', exit_code: '2', outcome: 'error', stderr: 'blocked: tests' }) },
    { seq: 7, kind: 'turn.completed' },
  ];
  const tally = new HookTally();
  await runTurn('s1', 'go', 0, { api: api(events), write: (s) => { out += s; }, sleep: async () => {}, hooks: tally });
  assert.match(out, /hooks: SessionStart 2 ok/);
  assert.match(out, /! hook Stop blocked \(exit 2\): blocked: tests/);
  assert.match(out, /hooks: Stop 0 ok, 1 failed/);
  assert.doesNotMatch(out, /system\/hook/);
  assert.equal(tally.size, 3);
});

test('/hooks reports the session tally', async () => {
  let out = '';
  const lines = ['go', '/hooks', '/exit'];
  await runAgentRepl(['atlas', '--new'], {
    api: api([{ seq: 1, ...resp() }, { seq: 2, kind: 'turn.completed' }]),
    write: (s) => { out += s; }, sleep: async () => {},
    storePath: `${process.env.TEMP || '/tmp'}/awsh-hooks-test-${process.pid}.json`,
    readLine: async () => lines.shift() ?? null,
  });
  assert.match(out, / {2}hooks: SessionStart 1 ok/);
});
