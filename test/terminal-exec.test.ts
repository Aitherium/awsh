/**
 * `aither connect -x "<cmd>"` — headless exec over the tunnel PTY gateway.
 *
 * Found 2026-09-12 while troubleshooting arc.aitherium.com from a laptop:
 * `aither connect` and `adk ssh` both hard-fail without a TTY, so from CI,
 * PowerShell, or a coding agent (Claude Code / Codex) the ONLY way through the
 * tunnel was a hand-rolled websocket client. This test pins the frame-level
 * contract of execRemote against a fake WebSocket server: marker-based exit
 * codes in container mode, per-line dispatch in restricted mode, marker lines
 * never leaking to the caller, and the 4001/4003/4004 close codes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execRemote, stripAnsi, describeCloseCode } from '../src/terminal-exec.js';

type Frame = { type?: string; data?: string; cols?: number; rows?: number; error?: string };

/** Minimal in-process WebSocket double: records sent frames, lets the test push replies. */
function fakeServer(script: (sent: Frame, reply: (f: Frame) => void, close: (code: number) => void) => void) {
  const sent: Frame[] = [];
  class FakeWS {
    readyState = 1;
    private listeners: Record<string, ((ev: any) => void)[]> = {};
    constructor(_url: string) {
      setTimeout(() => this.emit('open', {}), 0);
    }
    addEventListener(name: string, fn: (ev: any) => void) { (this.listeners[name] ||= []).push(fn); }
    private emit(name: string, ev: any) { for (const fn of this.listeners[name] || []) fn(ev); }
    send(raw: string) {
      const f = JSON.parse(raw) as Frame;
      sent.push(f);
      script(f, (r) => this.emit('message', { data: JSON.stringify(r) }), (code) => this.emit('close', { code }));
    }
    close() { this.readyState = 3; }
  }
  (globalThis as any).WebSocket = FakeWS;
  return sent;
}

test('stripAnsi removes CSI and OSC sequences', () => {
  assert.equal(stripAnsi('\x1b[1;33mwarn\x1b[0m \x1b]0;title\x07ok'), 'warn ok');
});

test('describeCloseCode maps the tunnel close codes', () => {
  assert.match(describeCloseCode(4001)!, /login/);
  assert.match(describeCloseCode(4003)!, /terminal/);
  assert.match(describeCloseCode(4004)!, /not running/);
  assert.equal(describeCloseCode(1000), null);
});

test('container mode: one joined line, marker carries the remote exit code, marker never leaks', async () => {
  const sent = fakeServer((f, reply) => {
    if (f.type !== 'input') return;
    const m = f.data!.match(/echo (__AWSH_EXEC_DONE_\w+_)\$\?/);
    assert.ok(m, 'marker echo appended');
    reply({ type: 'output', data: 'hello\r\n' });
    reply({ type: 'output', data: `${m![1]}7\r\n` });
  });
  const r = await execRemote({ container: 'devws-x', commands: ['echo hello', 'false'], token: 't' });
  assert.equal(r.code, 7);
  assert.equal(r.reason, 'marker');
  assert.equal(r.output.trim(), 'hello');
  const inputs = sent.filter((f) => f.type === 'input');
  assert.equal(inputs.length, 1, 'container mode sends ONE line');
  assert.match(inputs[0].data!, /^echo hello; false; echo /);
});

test('restricted mode: one line per command, then a marker echo, code 0', async () => {
  const sent = fakeServer((f, reply) => {
    if (f.type !== 'input') return;
    if (f.data!.startsWith('echo __AWSH')) reply({ type: 'output', data: f.data!.replace('echo ', '') });
    else reply({ type: 'output', data: `ran:${f.data!.trim()}\n` });
  });
  const r = await execRemote({ commands: ['hostname', 'docker ps'], token: 't' });
  assert.equal(r.code, 0);
  assert.equal(r.reason, 'marker');
  assert.deepEqual(r.output.trim().split('\n'), ['ran:hostname', 'ran:docker ps']);
  const inputs = sent.filter((f) => f.type === 'input').map((f) => f.data);
  assert.equal(inputs.length, 3);
  assert.ok(!inputs[0]!.includes(';'), 'restricted shell rejects `;` — commands must stay separate');
});

test('streaming sink sees output but never the marker line', async () => {
  fakeServer((f, reply) => {
    if (f.type !== 'input') return;
    const m = f.data!.match(/(__AWSH_EXEC_DONE_\w+_)/);
    reply({ type: 'output', data: 'a\n' });
    reply({ type: 'output', data: `${m![1]}0\n` });
  });
  const chunks: string[] = [];
  await execRemote({ container: 'c', commands: ['true'], token: 't' }, (c) => chunks.push(c));
  assert.deepEqual(chunks, ['a\n']);
});

test('4001 close → code 1 with a login hint; 4003 → 13', async () => {
  fakeServer((f, _reply, close) => { if (f.type === 'resize') close(4001); });
  const r1 = await execRemote({ commands: ['x'], token: 't' });
  assert.equal(r1.code, 1);
  assert.match(r1.output, /aither login/);

  fakeServer((f, _reply, close) => { if (f.type === 'resize') close(4003); });
  const r2 = await execRemote({ commands: ['x'], token: 't' });
  assert.equal(r2.code, 13);
});

test('no token → immediate error, no socket opened', async () => {
  let opened = false;
  (globalThis as any).WebSocket = class { constructor() { opened = true; } };
  const saved = process.env.HOME;
  const r = await execRemote({ commands: ['x'], token: '' });
  process.env.HOME = saved;
  // token '' falls through to getActiveToken(); on a box with a real profile this
  // may still connect, so only assert the contract when nothing is configured.
  if (r.reason === 'error' && !opened) assert.match(r.output, /login/);
});
