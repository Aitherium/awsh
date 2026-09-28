/**
 * `aither harness wrap <harness>`: a daemon-owned pty tab. `claude` must launch its
 * PTY twin `claude-tty` (the real TUI), then attach this terminal to it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWrap, wrapSessionBody } from '../src/harness-client.js';

test('wrap claude launches claude-tty, titled after the cwd', () => {
  const b = wrapSessionBody(['claude'], 'C:\\work\\awdk');
  assert.equal(b.harness, 'claude-tty');
  assert.equal(b.cwd, 'C:\\work\\awdk');
  assert.equal(b.title, 'awdk');
  assert.equal(wrapSessionBody([], '/home/u/repo').harness, 'claude-tty', 'bare wrap defaults to claude');
  assert.equal(wrapSessionBody([], '/home/u/repo').title, 'repo');
});

test('other harnesses and flags pass through', () => {
  const b = wrapSessionBody(['terminal', '--cwd', '/srv/x', '--title', 'T', '--model-profile', 'deepseek-flash'], '/ignored');
  assert.deepEqual(b, { harness: 'terminal', cwd: '/srv/x', title: 'T', model_profile: 'deepseek-flash' });
  assert.equal(wrapSessionBody(['--harness', 'claude'], '/a').harness, 'claude-tty');
});

test('runWrap POSTs /sessions then attaches THIS terminal to the created id', async () => {
  const calls: { path: string; body: any }[] = [];
  let attached = '';
  const code = await runWrap(['claude'], {
    api: async <T>(path: string, init?: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      return { id: 'sess-123' } as T;
    },
    attach: async (id) => { attached = id; return 0; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/sessions');
  assert.equal(calls[0].body.harness, 'claude-tty');
  assert.equal(attached, 'sess-123');
});
