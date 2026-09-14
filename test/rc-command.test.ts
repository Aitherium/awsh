/**
 * `awsh rc` — the alias, and the refusal.
 *
 * Two things must be true and neither is obvious from reading the source:
 *  - the flags a person types reach `adk rc` UNCHANGED (awdk's argparse is the
 *    only validator; a copy of its flag table here would be wrong the first time
 *    awdk added one), and
 *  - a machine WITHOUT awdk gets the exact install line and exit 2, not an
 *    ENOENT that reads as "awsh is broken".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adkCandidates, rcMissingMessage, runRcCommand, RC_INSTALL_LINE, RC_MISSING_EXIT,
} from '../src/rc-command.js';

type Call = { cmd: string; args: string[] };

function recorder(outcome: (cmd: string) => { status?: number; error?: Error }) {
  const calls: Call[] = [];
  const spawn = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return outcome(cmd) as never;
  };
  return { calls, spawn };
}

test('adkCandidates: the Windows shim name comes first, POSIX has one', () => {
  assert.deepEqual(adkCandidates('win32'), ['adk.exe', 'adk']);
  assert.deepEqual(adkCandidates('linux'), ['adk']);
  assert.deepEqual(adkCandidates('darwin'), ['adk']);
});

test('runRcCommand: execs `adk rc` and forwards every flag verbatim', () => {
  const { calls, spawn } = recorder(() => ({ status: 0 }));
  const code = runRcCommand(
    ['--node-class', 'laptop', '--harness-url', 'http://127.0.0.1:8362', '--once'],
    { spawn, platform: 'linux' },
  );
  assert.equal(code, 0);
  assert.deepEqual(calls, [{
    cmd: 'adk',
    args: ['rc', '--node-class', 'laptop', '--harness-url', 'http://127.0.0.1:8362', '--once'],
  }]);
});

test('runRcCommand: no flags is still `adk rc`, not a bare `adk`', () => {
  const { calls, spawn } = recorder(() => ({ status: 0 }));
  runRcCommand([], { spawn, platform: 'linux' });
  assert.deepEqual(calls, [{ cmd: 'adk', args: ['rc'] }]);
});

test('runRcCommand: the child exit code is this command exit code', () => {
  const { spawn } = recorder(() => ({ status: 7 }));
  assert.equal(runRcCommand([], { spawn, platform: 'linux' }), 7);
});

test('runRcCommand: on Windows it falls from adk.exe to adk before giving up', () => {
  const { calls, spawn } = recorder(cmd =>
    cmd === 'adk.exe' ? { error: new Error('ENOENT') } : { status: 0 },
  );
  assert.equal(runRcCommand(['--once'], { spawn, platform: 'win32' }), 0);
  assert.deepEqual(calls.map(c => c.cmd), ['adk.exe', 'adk']);
});

test('runRcCommand: without awdk it prints the exact install line and exits 2', () => {
  const lines: string[] = [];
  const { calls, spawn } = recorder(() => ({ error: new Error('ENOENT') }));
  const code = runRcCommand([], { spawn, platform: 'linux', log: l => lines.push(l) });

  assert.equal(code, RC_MISSING_EXIT);
  assert.equal(calls.length, 1);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(RC_INSTALL_LINE), lines[0]);
});

test('rcMissingMessage: carries the literal `pip install awdk && adk rc`', () => {
  assert.ok(rcMissingMessage().includes('pip install awdk && adk rc'));
});
