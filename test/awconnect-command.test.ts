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
import { buildAwconnectArgv, runAwconnectCommand, AWDK_INSTALL_HINT } from '../src/awconnect-command.js';

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
