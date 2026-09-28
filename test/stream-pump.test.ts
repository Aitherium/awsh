/**
 * Ctrl+Z / /fg job control (ROADMAP: "AitherShell: background a running
 * foreground task"). Before this, a foreground chat could only be cancelled:
 * there was no way to detach the renderer while the stream kept running, and
 * no /fg to bring it back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StreamPump, bindSuspendKey, type PumpEvent } from '../src/stream-pump.js';
import { adoptStreamJob, takeStreamJob, latestStreamJobId, getJob } from '../src/jobs.js';

/** A hand-driven async stream: push() events, end() or fail() it. */
function controlledStream() {
  const queue: PumpEvent[] = [];
  let waiting: ((v: void) => void) | null = null;
  let ended = false;
  let error: unknown = null;
  const wake = () => { const w = waiting; waiting = null; w?.(); };
  const iterable: AsyncIterable<PumpEvent> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift()!; continue; }
        if (error) throw error;
        if (ended) return;
        await new Promise<void>((r) => { waiting = r; });
      }
    },
  };
  return {
    iterable,
    push(e: PumpEvent) { queue.push(e); wake(); },
    end() { ended = true; wake(); },
    fail(e: unknown) { error = e; wake(); },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const tok = (t: string): PumpEvent => ({ type: 'token', data: { t } });

test('foreground: events reach the sink and waitForeground resolves done', async () => {
  const s = controlledStream();
  const seen: string[] = [];
  const pump = new StreamPump(s.iterable, (e) => seen.push(e.data.t));
  const fg = pump.waitForeground();
  s.push(tok('a')); s.push(tok('b')); s.end();
  assert.equal(await fg, 'done');
  assert.deepEqual(seen, ['a', 'b']);
});

test('Ctrl+Z detaches the renderer WITHOUT ending the stream; /fg replays and follows', async () => {
  const s = controlledStream();
  const first: string[] = [];
  const pump = new StreamPump(s.iterable, (e) => first.push(e.data.t));
  const fg = pump.waitForeground();
  s.push(tok('a')); await tick();
  assert.equal(pump.detach(), true);
  assert.equal(await fg, 'detached');
  s.push(tok('b')); await tick();
  assert.deepEqual(first, ['a'], 'a detached renderer receives nothing');
  assert.equal(pump.done, false, 'the stream is still running');

  const second: string[] = [];
  pump.attach((e) => second.push(e.data.t));
  assert.deepEqual(second, ['a', 'b'], '/fg replays what it missed');
  const fg2 = pump.waitForeground();
  s.push(tok('c')); s.end();
  assert.equal(await fg2, 'done');
  assert.deepEqual(second, ['a', 'b', 'c']);
});

test('a stream error (Ctrl+C abort) rejects the foreground wait like the old for-await', async () => {
  const s = controlledStream();
  const pump = new StreamPump(s.iterable, () => {});
  const fg = pump.waitForeground();
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  s.fail(abort);
  await assert.rejects(fg, (e: any) => e.name === 'AbortError');
});

test('detach after the stream ended is refused', async () => {
  const s = controlledStream();
  const pump = new StreamPump(s.iterable, () => {});
  s.end();
  await pump.finished;
  assert.equal(pump.detach(), false);
});

test('bindSuspendKey: SIGTSTP on POSIX, ctrl+z keypress on win32, unbinds cleanly', () => {
  const rl = new EventEmitter();
  const stdin = new EventEmitter();
  let hits = 0;
  const unPosix = bindSuspendKey(rl as any, stdin as any, 'linux', () => hits++);
  rl.emit('SIGTSTP');
  stdin.emit('keypress', '\x1a', { ctrl: true, name: 'z' });
  assert.equal(hits, 1, 'POSIX listens to readline SIGTSTP only');
  unPosix();
  rl.emit('SIGTSTP');
  assert.equal(hits, 1);
  assert.equal(rl.listenerCount('SIGTSTP'), 0, 'idle Ctrl+Z keeps the terminal default');

  const unWin = bindSuspendKey(rl as any, stdin as any, 'win32', () => hits++);
  stdin.emit('keypress', 'z', { ctrl: false, name: 'z' });
  stdin.emit('keypress', '\x1a', { ctrl: true, name: 'z' });
  assert.equal(hits, 2);
  unWin();
  assert.equal(stdin.listenerCount('keypress'), 0);
});

test('a suspended chat becomes a job that completes with the answer', async () => {
  const s = controlledStream();
  const pump = new StreamPump(s.iterable, () => {});
  s.push(tok('hel')); await tick();
  pump.detach();
  const job = adoptStreamJob(pump, 'Chat: hi', new AbortController(), 'hi there');
  assert.equal(latestStreamJobId(), job.id);
  s.push(tok('lo')); s.end();
  await pump.finished; await tick();
  assert.equal(job.status, 'completed');
  assert.equal(job.output.at(-1), 'hello');
  assert.equal(latestStreamJobId(), null);
});

test('/fg takes the job back: it leaves the table and is never finished as background', async () => {
  const s = controlledStream();
  const pump = new StreamPump(s.iterable, () => {});
  pump.detach();
  const job = adoptStreamJob(pump, 'Chat: q', null, 'the full question');
  const taken = takeStreamJob(job.id);
  assert.notEqual(typeof taken, 'string');
  if (typeof taken === 'string') return;
  assert.equal(taken.pump, pump);
  assert.equal(taken.prompt, 'the full question');
  assert.equal(getJob(job.id), undefined);
  s.end(); await pump.finished; await tick();
  assert.equal(job.status, 'running', 'the foreground owns completion now');
  assert.match(String(takeStreamJob(job.id)), /No job/);
});
