/**
 * `aither awconnect` — a thin delegate to `adk awconnect`.
 *
 * What must hold: the argv handed to python is exactly `-m adk.cli awconnect
 * <action> <flags…>`; status is the default; an unknown verb is refused (not
 * forwarded to adk as a flag soup); without awdk the answer is the install line
 * and python is never run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAwconnectArgv, runAwconnectCommand, AWDK_INSTALL_HINT, AWCONNECT_WEBSTORE_URL,
} from '../src/awconnect-command.js';

test('argv: default is status; flags pass through', () => {
  assert.deepEqual(buildAwconnectArgv([]), ['-m', 'adk.cli', 'awconnect', 'status']);
  assert.deepEqual(buildAwconnectArgv(['--json']), ['-m', 'adk.cli', 'awconnect', 'status', '--json']);
  assert.deepEqual(buildAwconnectArgv(['install', '--browser', 'edge', '--wait', '0']),
    ['-m', 'adk.cli', 'awconnect', 'install', '--browser', 'edge', '--wait', '0']);
  assert.deepEqual(buildAwconnectArgv(['PATH']), ['-m', 'adk.cli', 'awconnect', 'path']);
});

test('unknown verb is refused with usage, python never runs', () => {
  const lines: string[] = [];
  let ran = false;
  const code = runAwconnectCommand(['uninstall'], {
    log: (l) => lines.push(l), adkReady: () => true, runPython: () => { ran = true; return 0; },
  });
  assert.equal(code, 2);
  assert.equal(ran, false);
  assert.match(lines.join('\n'), /aither awconnect install/);
});

test('delegates and returns adk exit status', () => {
  const seen: string[][] = [];
  const code = runAwconnectCommand(['status'], {
    log: () => {}, adkReady: () => true, runPython: (argv) => { seen.push(argv); return 1; },
  });
  assert.equal(code, 1);
  assert.deepEqual(seen, [['-m', 'adk.cli', 'awconnect', 'status']]);
});

test('without awdk: the install line, exit 3, python not run', () => {
  const lines: string[] = [];
  let ran = false;
  const code = runAwconnectCommand(['install'], {
    log: (l) => lines.push(l), adkReady: () => false, runPython: () => { ran = true; return 0; },
  });
  assert.equal(code, 3);
  assert.equal(ran, false);
  assert.ok(lines.join('\n').includes(AWDK_INSTALL_HINT));
});

test('pair: pending/approve/revoke pass through to adk awconnect pair', () => {
  const base = ['-m', 'adk.cli', 'awconnect', 'pair'];
  assert.deepEqual(buildAwconnectArgv(['pair']), [...base, 'pending']);
  assert.deepEqual(buildAwconnectArgv(['pair', 'pending']), [...base, 'pending']);
  assert.deepEqual(buildAwconnectArgv(['pair', 'revoke']), [...base, 'revoke']);
  assert.deepEqual(buildAwconnectArgv(['pair', 'approve', '123456']), [...base, 'approve', '123456']);
  // people copy the code as "123 456" or "123-456"
  assert.deepEqual(buildAwconnectArgv(['pair', 'APPROVE', '123', '456']), [...base, 'approve', '123456']);
  assert.deepEqual(buildAwconnectArgv(['pair', 'approve', '123-456']), [...base, 'approve', '123456']);
});

test('pair: anything but an exact subcommand is refused, never forwarded', () => {
  for (const bad of [
    ['pair', 'approve'],                 // no code
    ['pair', 'approve', '12345'],        // too short
    ['pair', 'approve', '123456', '--x'],
    ['pair', 'approve', 'abcdef'],
    ['pair', 'revoke', '--all'],
    ['pair', 'pending', 'extra'],
    ['pair', 'grant'],
    ['pair', '--json'],
  ]) {
    assert.equal(buildAwconnectArgv(bad), null, bad.join(' '));
  }
  const lines: string[] = [];
  let ran = false;
  const code = runAwconnectCommand(['pair', 'approve'], {
    log: (l) => lines.push(l), adkReady: () => true, runPython: () => { ran = true; return 0; },
  });
  assert.equal(code, 2);
  assert.equal(ran, false);
  assert.match(lines.join('\n'), /aither awconnect pair approve <code>/);
});

test('pair approve delegates and returns adk exit status', () => {
  const seen: string[][] = [];
  const code = runAwconnectCommand(['pair', 'approve', '654321'], {
    log: () => {}, adkReady: () => true, runPython: (argv) => { seen.push(argv); return 0; },
  });
  assert.equal(code, 0);
  assert.deepEqual(seen, [['-m', 'adk.cli', 'awconnect', 'pair', 'approve', '654321']]);
});

test('usage names the Chrome Web Store listing', () => {
  const lines: string[] = [];
  runAwconnectCommand(['--help'], { log: (l) => lines.push(l) });
  assert.ok(lines.join('\n').includes(AWCONNECT_WEBSTORE_URL));
  assert.match(AWCONNECT_WEBSTORE_URL, /peeojgjhjficedkncdejbfnacooodbak$/);
});
