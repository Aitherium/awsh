/**
 * `/rc` inside the REPL -- the same `adk rc`, held in the background.
 *
 * Pinned: flags reach `adk rc` verbatim; start-up output (device, sessions URL, QR)
 * is relayed until adk says it is holding, then the prompt comes back; `/rc` again
 * is status (no second link); `/rc stop` stops the one this shell holds; an `adk rc`
 * that exits before holding (not signed in) points at /link; no adk = the install
 * line and exit 2; `/devices` maps onto `adk devices` verbs.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  RC_INSTALL_LINE, RC_MISSING_EXIT, RC_SESSIONS_URL, currentRcSession, resetRcSessionForTests,
  runRcSlash,
} from '../src/rc-command.js';
import { devicesArgv, runDevicesCommand } from '../src/devices-command.js';

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
}

function harness(script: (c: FakeChild) => void, missing: string[] = []) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawnBackground = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const c = new FakeChild();
    children.push(c);
    setImmediate(() => {
      if (missing.includes(cmd)) { c.emit('error', new Error('ENOENT')); return; }
      c.emit('spawn');
      script(c);
    });
    return c;
  };
  const lines: string[] = [];
  const killed: number[] = [];
  return {
    calls, children, lines, killed,
    deps: {
      spawnBackground, platform: 'linux', log: (l: string) => lines.push(l),
      kill: (s: { child: { pid?: number } }) => { killed.push(s.child.pid ?? -1); },
      startupWaitMs: 2000,
    },
  };
}

const HOLDING = (c: FakeChild) => {
  c.stdout.write('Remote control\n');
  c.stdout.write('  Device:   node-abc (laptop)\n');
  c.stdout.write(`  Sessions: ${RC_SESSIONS_URL}   (scan to open on your phone)\n`);
  c.stdout.write('    █▀▀█ ▄▄\n');
  c.stdout.write('Holding the link. Ctrl-C to stop.\n');
};

beforeEach(() => resetRcSessionForTests());

test('/rc starts `adk rc` with the flags verbatim and returns once it holds', async () => {
  const h = harness(HOLDING);
  const code = await runRcSlash(['--node-class', 'deck'], h.deps);
  assert.equal(code, 0);
  assert.deepEqual(h.calls, [{ cmd: 'adk', args: ['rc', '--node-class', 'deck'] }]);
  const out = h.lines.join('\n');
  assert.ok(out.includes(RC_SESSIONS_URL), 'the sessions URL is relayed');
  assert.ok(out.includes('█▀▀█'), 'the QR adk printed is relayed');
  assert.ok(out.includes('holding the link'));
  assert.equal(currentRcSession()?.nodeId, 'node-abc');
});

test('/rc while holding is status, never a second link', async () => {
  const h = harness(HOLDING);
  await runRcSlash([], h.deps);
  h.lines.length = 0;
  assert.equal(await runRcSlash([], h.deps), 0);
  assert.equal(h.calls.length, 1, 'no second adk rc');
  const out = h.lines.join('\n');
  assert.ok(out.includes('node-abc') && out.includes(RC_SESSIONS_URL));
  assert.ok(out.includes('█▀▀█'), 'status re-shows the QR');
});

test('/rc stop stops the held link and clears it', async () => {
  const h = harness(HOLDING);
  await runRcSlash([], h.deps);
  assert.equal(await runRcSlash(['stop'], h.deps), 0);
  assert.deepEqual(h.killed, [4242]);
  assert.equal(currentRcSession(), null);
  h.lines.length = 0;
  await runRcSlash(['status'], h.deps);
  assert.ok(h.lines.join('\n').includes('not running'));
});

test('an adk rc that exits before holding says why and points at /link', async () => {
  const h = harness((c) => {
    c.stdout.write('x Not signed in.\n');
    c.stdout.end();
    setImmediate(() => c.emit('exit', 1, null));
  });
  const code = await runRcSlash([], h.deps);
  assert.equal(code, 1);
  const out = h.lines.join('\n');
  assert.ok(out.includes('Not signed in'));
  assert.ok(out.includes('/link'));
  assert.equal(currentRcSession(), null);
});

test('/rc without adk prints the install line and returns 2', async () => {
  const h = harness(HOLDING, ['adk']);
  const code = await runRcSlash([], h.deps);
  assert.equal(code, RC_MISSING_EXIT);
  assert.ok(h.lines.join('\n').includes(RC_INSTALL_LINE));
});

test('/rc --once runs in the foreground like `awsh rc`', async () => {
  const seen: string[][] = [];
  const code = await runRcSlash(['--once'], { runForeground: (a) => { seen.push(a); return 0; } });
  assert.equal(code, 0);
  assert.deepEqual(seen, [['--once']]);
});

test('/devices maps onto adk devices verbs (bare = list)', async () => {
  assert.deepEqual(devicesArgv([]), ['devices', 'list']);
  assert.deepEqual(devicesArgv(['add']), ['devices', 'add']);
  assert.deepEqual(devicesArgv(['rm', 'node-1']), ['devices', 'rm', 'node-1']);
  const calls: Array<[string, string[]]> = [];
  const code = await runDevicesCommand(['add', '--no-wait'], {
    platform: 'win32',
    spawn: async (cmd, args) => { calls.push([cmd, args]); return cmd === 'adk.exe' ? null : 0; },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [
    ['adk.exe', ['devices', 'add', '--no-wait']],
    ['adk', ['devices', 'add', '--no-wait']],
  ]);
});

test('/devices without adk names the install line and returns 2', async () => {
  const lines: string[] = [];
  const code = await runDevicesCommand([], {
    platform: 'linux', spawn: async () => null, log: (l) => lines.push(l),
  });
  assert.equal(code, RC_MISSING_EXIT);
  assert.ok(lines.join('\n').includes('pip install awdk'));
});
