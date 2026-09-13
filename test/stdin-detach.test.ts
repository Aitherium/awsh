import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runWithDetachedStdin } from '../src/stdin-detach.js';

/** A fake stdin that records raw-mode/resume and behaves like an EventEmitter. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  rawMode: boolean | null = null;
  resumed = 0;
  setRawMode(mode: boolean) { this.rawMode = mode; return this; }
  resume() { this.resumed++; return this; }
}

function fakeRl() {
  let paused = 0;
  return { pause() { paused++; }, get paused() { return paused; } };
}

test('detaches the outer listeners for the duration, restores them exactly after', async () => {
  const stdin = new FakeStdin();
  const rl = fakeRl();
  const ownData = () => {};
  const ownKeypress = () => {};
  stdin.on('data', ownData);
  stdin.on('keypress', ownKeypress);

  let duringData = -1;
  let duringKeypress = -1;
  const result = await runWithDetachedStdin(stdin, rl, async () => {
    // The outer listeners must be gone while the prompt runs.
    duringData = stdin.listenerCount('data');
    duringKeypress = stdin.listenerCount('keypress');
    // Simulate what inquirer does: attach its own listener.
    stdin.on('keypress', () => {});
    return 'picked';
  });

  assert.equal(result, 'picked');
  assert.equal(duringData, 0, 'outer data listener still attached during prompt');
  assert.equal(duringKeypress, 0, 'outer keypress listener still attached during prompt');
  // Exactly our two listeners are back, and the prompt's temporary one is gone.
  assert.deepEqual(stdin.rawListeners('data'), [ownData]);
  assert.deepEqual(stdin.rawListeners('keypress'), [ownKeypress]);
  assert.equal(rl.paused, 1, 'readline was paused once');
  assert.equal(stdin.rawMode, false, 'raw mode turned off before the prompt');
  assert.equal(stdin.resumed, 1, 'stdin resumed for the prompt');
});

test('restores the outer listeners even when the prompt throws', async () => {
  const stdin = new FakeStdin();
  const rl = fakeRl();
  const ownData = () => {};
  const ownKeypress = () => {};
  stdin.on('data', ownData);
  stdin.on('keypress', ownKeypress);

  await assert.rejects(
    runWithDetachedStdin(stdin, rl, async () => {
      stdin.on('keypress', () => {});  // inquirer's listener, must not survive
      throw new Error('ctrl-c');
    }),
    /ctrl-c/,
  );

  assert.deepEqual(stdin.rawListeners('data'), [ownData]);
  assert.deepEqual(stdin.rawListeners('keypress'), [ownKeypress]);
});

test('skips setRawMode when stdin is not a TTY', async () => {
  const stdin = new FakeStdin();
  stdin.isTTY = false;
  const rl = fakeRl();
  await runWithDetachedStdin(stdin, rl, async () => 0);
  assert.equal(stdin.rawMode, null, 'setRawMode must not be called off-TTY');
});
