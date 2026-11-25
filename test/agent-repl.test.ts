/**
 * `awsh agent [name]` -- the tool-using agent REPL over the harness daemon.
 *
 * What must hold: a named agent is `claude --agent <name>` (harness `claude`, with a
 * permission mode, so tools run headless); a remembered live session is REATTACHED,
 * a dead one WOKEN from its log, an unknown id resumed as a Claude conversation; a
 * turn streams until turn.completed; Ctrl+C sends exactly one interrupt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AGENT, agentSessionBody, endsTurn, openAgentSession, parseAgentArgs,
  renderEvent, runAgentRepl, runTurn, saveRecord, storeKey,
} from '../src/agent-repl.js';

const tmpStore = () => join(mkdtempSync(join(tmpdir(), 'awsh-agent-')), 'sessions.json');

type Call = { path: string; method: string; body?: any };
function fakeApi(routes: (c: Call) => any) {
  const calls: Call[] = [];
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const c: Call = { path, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = routes(c);
    if (r instanceof Error) throw r;
    return r as T;
  };
  return { api, calls };
}

test('parseAgentArgs: name, flags, default agent and permission mode', () => {
  const a = parseAgentArgs(['@Demiurge', '--new', '--model', 'opus', 'fix', 'it'], '/w');
  assert.equal(a.agent, 'demiurge');
  assert.equal(a.fresh, true);
  assert.equal(a.model, 'opus');
  assert.equal(a.prompt, 'fix it');
  assert.equal(a.permissionMode, 'acceptEdits');
  assert.equal(parseAgentArgs([], '/w').agent, DEFAULT_AGENT);
  assert.equal(parseAgentArgs(['--permission-mode', 'plan'], '/w').permissionMode, 'plan');
});

test('agentSessionBody is claude --agent <name> with a permission mode', () => {
  const body = agentSessionBody(parseAgentArgs(['lyra'], '/w'), 'cl-1');
  assert.equal(body.harness, 'claude');
  assert.deepEqual(body.extra_args, ['--agent', 'lyra']);
  assert.equal(body.permission_mode, 'acceptEdits');
  assert.equal(body.resume_session_id, 'cl-1');
  assert.equal(body.cwd, '/w');
  assert.ok(String(body.title).startsWith('awsh · '));
});

test('open: a remembered LIVE session is reattached, nothing created', async () => {
  const storePath = tmpStore();
  saveRecord({ id: 's1', agent: 'atlas', cwd: '/w', updated_at: 1 }, storePath);
  const { api, calls } = fakeApi((c) => (c.path === '/sessions/s1' ? { id: 's1', state: 'idle', last_seq: 42 } : new Error('unexpected')));
  const s = await openAgentSession(parseAgentArgs(['atlas'], '/w'), { api, storePath });
  assert.deepEqual([s.id, s.how, s.cursor], ['s1', 'live', 42]);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('open: a remembered DEAD session is woken from its log', async () => {
  const storePath = tmpStore();
  saveRecord({ id: 's1', agent: 'atlas', cwd: '/w', updated_at: 1 }, storePath);
  const { api, calls } = fakeApi((c) => {
    if (c.path === '/sessions/s1') return { id: 's1', state: 'exited', last_seq: 9 };
    if (c.path === '/sessions/s1/wake') return { woken: true, session: { id: 's1', state: 'starting', last_seq: 9 } };
    return new Error('unexpected');
  });
  const s = await openAgentSession(parseAgentArgs(['atlas'], '/w'), { api, storePath });
  assert.equal(s.how, 'woken');
  assert.ok(calls.some((c) => c.path === '/sessions/s1/wake' && c.method === 'POST'));
});

test('open: --resume with an id the daemon does not know resumes it as a Claude session', async () => {
  const { api, calls } = fakeApi((c) => {
    if (c.path === '/sessions/cl-9') return new Error('no such session');
    if (c.path === '/sessions' && c.method === 'POST') return { id: 'new1', last_seq: 0 };
    return new Error('unexpected');
  });
  const s = await openAgentSession(parseAgentArgs(['demiurge', '--resume', 'cl-9'], '/w'), { api, storePath: tmpStore() });
  assert.equal(s.how, 'claude-resume');
  assert.equal(calls.find((c) => c.method === 'POST')?.body.resume_session_id, 'cl-9');
});

test('open: --new ignores the remembered session', async () => {
  const storePath = tmpStore();
  saveRecord({ id: 's1', agent: 'atlas', cwd: '/w', updated_at: 1 }, storePath);
  const { api, calls } = fakeApi((c) => (c.path === '/sessions' && c.method === 'POST' ? { id: 'n2' } : new Error('unexpected')));
  const s = await openAgentSession(parseAgentArgs(['atlas', '--new'], '/w'), { api, storePath });
  assert.deepEqual([s.id, s.how], ['n2', 'new']);
  assert.ok(!calls.some((c) => c.path === '/sessions/s1'));
});

test('runTurn streams text and tool events until turn.completed', async () => {
  let page = 0;
  const { api, calls } = fakeApi((c) => {
    if (c.path.endsWith('/submit')) return { ok: true };
    if (c.path.includes('/events')) {
      page++;
      return page === 1
        ? { state: 'busy', events: [{ seq: 5, kind: 'text.delta', text: 'hel' }, { seq: 6, kind: 'tool.call', tool: 'Read' }] }
        : { state: 'idle', events: [{ seq: 7, kind: 'text.delta', text: 'lo', data: { harness_session_id: 'cl-1' } }, { seq: 8, kind: 'turn.completed' }] };
    }
    return new Error('unexpected');
  });
  let out = '';
  const r = await runTurn('s1', 'hi', 4, { api, write: (s) => { out += s; }, sleep: async () => {} });
  assert.deepEqual([r.cursor, r.ended, r.harnessSessionId], [8, 'turn', 'cl-1']);
  assert.match(out, /hel/);
  assert.match(out, /-> Read/);
  assert.equal(calls[0].body.text, 'hi');
  assert.equal(calls[0].body.submit, true);
  assert.ok(calls[1].path.endsWith('events?after=4'));
});

test('runTurn waits once for a starting session that refuses input', async () => {
  let submits = 0;
  const { api, calls } = fakeApi((c) => {
    if (c.path.endsWith('/submit')) return ++submits === 1 ? new Error('session starting cannot accept input') : { ok: true };
    if (c.path.includes('/wait')) return { matched: 'ready' };
    if (c.path.includes('/events')) return { state: 'idle', events: [{ seq: 1, kind: 'turn.completed' }] };
    return new Error('unexpected');
  });
  await runTurn('s1', 'hi', 0, { api, write: () => {}, sleep: async () => {} });
  assert.equal(submits, 2);
  assert.ok(calls.some((c) => c.path.includes('/wait?until=ready,idle')));
});

test('Ctrl+C sends exactly one interrupt', async () => {
  let polls = 0;
  const { api, calls } = fakeApi((c) => {
    if (c.path.endsWith('/submit') || c.path.endsWith('/interrupt')) return { ok: true };
    if (c.path.includes('/events')) {
      polls++;
      return polls < 3 ? { state: 'busy', events: [] } : { state: 'idle', events: [{ seq: 2, kind: 'turn.completed' }] };
    }
    return new Error('unexpected');
  });
  const r = await runTurn('s1', 'go', 0, { api, write: () => {}, sleep: async () => {} }, () => true);
  assert.equal(r.ended, 'interrupted');
  assert.equal(calls.filter((c) => c.path.endsWith('/interrupt')).length, 1);
});

test('renderEvent / endsTurn', () => {
  assert.equal(renderEvent({ kind: 'text.delta', text: 'x' }), 'x');
  assert.equal(renderEvent({ kind: 'unknown' }), '');
  assert.ok(endsTurn({ kind: 'turn.completed' }));
  assert.ok(endsTurn({ kind: 'session.exited' }));
  assert.ok(!endsTurn({ kind: 'text.delta' }));
});

test('REPL: local /status runs locally, other text is a turn, /exit leaves; session remembered', async () => {
  const storePath = tmpStore();
  const lines = ['/status', 'do the thing', '/exit'];
  const localRan: string[] = [];
  const { api, calls } = fakeApi((c) => {
    if (c.path === '/sessions' && c.method === 'POST') return { id: 'r1', last_seq: 0 };
    if (c.path.endsWith('/submit')) return { ok: true };
    if (c.path.includes('/events')) return { state: 'idle', events: [{ seq: 3, kind: 'turn.completed', data: { harness_session_id: 'cl-7' } }] };
    return new Error(`unexpected ${c.path}`);
  });
  const rc = await runAgentRepl(['demiurge', '--new'], {
    api, storePath, write: () => {}, sleep: async () => {},
    readLine: async () => lines.shift() ?? null,
    local: { status: async () => { localRan.push('status'); } },
  });
  assert.equal(rc, 0);
  assert.deepEqual(localRan, ['status']);
  assert.deepEqual(calls.filter((c) => c.path.endsWith('/submit')).map((c) => c.body.text), ['do the thing']);
  const saved = JSON.parse(readFileSync(storePath, 'utf8'))[storeKey('demiurge', process.cwd())];
  assert.equal(saved.id, 'r1');
  assert.equal(saved.harness_session_id, 'cl-7');
});

test('REPL: an unreachable daemon is exit 1 with the remedy, not a throw', async () => {
  let out = '';
  const { api } = fakeApi(() => new Error('fetch failed'));
  const rc = await runAgentRepl(['atlas', '--new'], {
    api, storePath: tmpStore(), write: (s) => { out += s; }, readLine: async () => null,
  });
  assert.equal(rc, 1);
  assert.match(out, /adk harness serve/);
});

// ── WSL -> Windows host daemon (gap 4, measured 2026-11-09) ──────────────────
import { hostCwd, isUnreachable } from '../src/agent-repl.js';

const BS = String.fromCharCode(92);  // a typed backslash gets mangled by edit tooling

test('hostCwd maps WSL drive mounts to Windows paths only when crossing to Windows', () => {
  assert.equal(hostCwd('/mnt/c/AitherOS-Fresh', true), `C:${BS}AitherOS-Fresh`);
  assert.equal(hostCwd('/var/mnt/d/work/x/', true), `D:${BS}work${BS}x`);
  assert.equal(hostCwd('/mnt/c', true), `C:${BS}`);
  assert.equal(hostCwd('/root', true), '');
  assert.equal(hostCwd('/var/roothome', true), '');
  assert.equal(hostCwd('/root', false), '/root');
});

test('REPL in WSL sends the Windows cwd to the host daemon', async () => {
  const { api, calls } = fakeApi((c) => (c.path === '/sessions' && c.method === 'POST' ? { id: 'w1' } : new Error('x')));
  await runAgentRepl(['atlas', '--new', '--cwd', '/mnt/c/AitherOS-Fresh'], {
    api, storePath: tmpStore(), write: () => {}, readLine: async () => null, crossesToWindows: true,
  });
  assert.equal(calls.find((c) => c.method === 'POST')?.body.cwd, `C:${BS}AitherOS-Fresh`);
});

test('a refusal is not blamed on a missing daemon; an unreachable daemon is', async () => {
  assert.ok(isUnreachable('fetch failed'));
  assert.ok(!isUnreachable(`cwd does not exist: ${BS}var${BS}roothome`));
  let out = '';
  const { api } = fakeApi(() => new Error('cwd is outside the allowed roots'));
  await runAgentRepl(['atlas', '--new'], { api, storePath: tmpStore(), write: (s) => { out += s; }, readLine: async () => null });
  assert.doesNotMatch(out, /adk harness serve/);
});
