/**
 * The pure half of the backend ladder's daemon-boot path (2026-09-19). The failure it
 * pins: awsh launched the local agent daemon, waited 2 s, fell to the cloud rung and
 * told the owner to /login while a healthy daemon was ~13 s from answering on :9001.
 * No process is spawned here; the wait loop itself is exercised by hand.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { bootWaitPlan, daemonStartCandidates } from '../src/backend-resolver.js';
import { cloudSignInHint } from '../src/config.js';

test('bootWaitPlan: default waits 25s, polls every 1s', () => {
  const p = bootWaitPlan({});
  assert.equal(p.waitMs, 25_000);
  assert.equal(p.pollMs, 1000);
});

test('bootWaitPlan: AITHERSHELL_ADK_BOOT_WAIT_S overrides, 0 disables the wait, junk falls back', () => {
  assert.equal(bootWaitPlan({ AITHERSHELL_ADK_BOOT_WAIT_S: '40' }).waitMs, 40_000);
  assert.equal(bootWaitPlan({ AITHERSHELL_ADK_BOOT_WAIT_S: '0' }).waitMs, 0);
  assert.equal(bootWaitPlan({ AITHERSHELL_ADK_BOOT_WAIT_S: 'soon' }).waitMs, 25_000);
  assert.equal(bootWaitPlan({ AITHERSHELL_ADK_BOOT_WAIT_S: '-3' }).waitMs, 25_000);
});

test('daemonStartCandidates: the hidden scheduled-task payload outranks the repo launcher', () => {
  const c = daemonStartCandidates({ home: '/h', here: '/repo/.PRODUCTS/.AITHERSHELL/cli/dist/x.js', root: '', explicit: '' });
  assert.equal(c[0].hidden, true);
  assert.equal(c[0].script, join('/h', '.aither', 'bin', 'hidden-tasks', 'AitherOS-AdkDaemon.cmd'));
  assert.equal(c[1].hidden, false);
  assert.ok(c[1].script.endsWith(join('awdk', 'adk-daemon-start.cmd')));
  assert.equal(c.length, 2);
});

test('daemonStartCandidates: an explicit ADK_DAEMON_START wins outright; AITHEROS_ROOT adds a last resort', () => {
  const c = daemonStartCandidates({ home: '/h', here: '/x/dist/x.js', root: '/root', explicit: '/mine.cmd' });
  assert.equal(c[0].script, '/mine.cmd');
  assert.equal(c[0].hidden, false);
  assert.equal(c[c.length - 1].script, join('/root', 'awdk', 'adk-daemon-start.cmd'));
  assert.equal(c.length, 4);
});

test('cloudSignInHint: names the booting daemon and its age instead of demanding /login', () => {
  const msg = cloudSignInHint({ url: 'http://127.0.0.1:9001', since: 10_000 }, 27_500);
  assert.match(msg, /127\.0\.0\.1:9001/);
  assert.match(msg, /launched 18s ago/);
  assert.match(msg, /Retry in a moment/);
  assert.doesNotMatch(msg, /^Cloud gateway requires sign-in/);
});

test('cloudSignInHint: with no booting daemon the sign-in instruction stands', () => {
  const msg = cloudSignInHint(undefined);
  assert.match(msg, /^Cloud gateway requires sign-in/);
  assert.match(msg, /\/login/);
});
