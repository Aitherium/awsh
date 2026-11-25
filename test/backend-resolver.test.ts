/**
 * The pure half of the backend ladder's daemon-boot path (2026-09-19). The failure it
 * pins: awsh launched the local agent daemon, waited 2 s, fell to the cloud rung and
 * told the owner to /login while a healthy daemon was ~13 s from answering on :9001.
 * No process is spawned here; the wait loop itself is exercised by hand.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  bootWaitPlan, daemonStartCandidates, localModelCandidates, tryLocalModelServer, LOCAL_MICROSCHEDULER_URL,
} from '../src/backend-resolver.js';
import type { ShellConfig } from '../src/config.js';
import { cloudSignInHint } from '../src/config.js';

test('bootWaitPlan: default waits 120s, polls every 1s', () => {
  const p = bootWaitPlan({});
  assert.equal(p.waitMs, 120_000);
  assert.equal(p.pollMs, 1000);
});

test('bootWaitPlan: AITHERSHELL_ADK_BOOT_WAIT_S overrides, 0 disables the wait, junk falls back', () => {
  assert.equal(bootWaitPlan({ AITHERSHELL_ADK_BOOT_WAIT_S: '40' }).waitMs, 40_000);
  assert.equal(bootWaitPlan({ AITHERSHELL_ADK_BOOT_WAIT_S: '0' }).waitMs, 0);
  assert.equal(bootWaitPlan({ AITHERSHELL_ADK_BOOT_WAIT_S: 'soon' }).waitMs, 120_000);
  assert.equal(bootWaitPlan({ AITHERSHELL_ADK_BOOT_WAIT_S: '-3' }).waitMs, 120_000);
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

// 2026-11-09, awnix fleet host: no agent daemon, no published Genesis, MicroScheduler
// healthy on :8150 -- awsh still chose the cloud gateway and refused every turn.
test('localModelCandidates: loopback llm_url first, then MicroScheduler, no duplicates', () => {
  assert.deepEqual(localModelCandidates('http://127.0.0.1:8080/v1/', {}), ['http://127.0.0.1:8080/v1', LOCAL_MICROSCHEDULER_URL]);
  assert.deepEqual(localModelCandidates(LOCAL_MICROSCHEDULER_URL, {}), [LOCAL_MICROSCHEDULER_URL]);
  assert.deepEqual(localModelCandidates('', {}), [LOCAL_MICROSCHEDULER_URL]);
});

test('localModelCandidates: a remote llm_url is never a LOCAL candidate; AITHERSHELL_LOCAL_LLM=0 drops the guess', () => {
  assert.deepEqual(localModelCandidates('https://gateway.example.com/v1', {}), [LOCAL_MICROSCHEDULER_URL]);
  assert.deepEqual(localModelCandidates('', { AITHERSHELL_LOCAL_LLM: '0' }), []);
  assert.deepEqual(localModelCandidates('http://localhost:8080/v1', { AITHERSHELL_LOCAL_LLM: '0' }), ['http://localhost:8080/v1']);
});

function bareConfig(over: Partial<ShellConfig> = {}): ShellConfig {
  return {
    genesisUrl: 'http://127.0.0.1:8001', defaultAgent: 'aither', sessionId: 's', historyFile: '/dev/null',
    identityUrl: 'http://127.0.0.1:8115', mcpUrl: '', inferenceMode: 'auto', llmUrl: '',
    requireAuth: false, backendType: 'unknown', backendName: '', endpointPinned: false, offline: false,
    ...over,
  } as ShellConfig;
}

test('tryLocalModelServer: a healthy MicroScheduler wins before the cloud; online keeps the default model', async () => {
  const cfg = bareConfig();
  const tried: string[] = [];
  const r = await tryLocalModelServer(cfg, {
    setModel: false,
    probe: async (u) => { tried.push(u); return u === LOCAL_MICROSCHEDULER_URL ? 'aither-orchestrator' : null; },
  });
  assert.equal(r?.chosen, 'local-llm');
  assert.equal(r?.url, LOCAL_MICROSCHEDULER_URL);
  assert.equal(cfg.llmUrl, LOCAL_MICROSCHEDULER_URL);
  assert.equal(cfg.inferenceMode, 'raw');
  assert.equal(cfg.model, undefined);
  assert.deepEqual(tried, [LOCAL_MICROSCHEDULER_URL]);
});

test('tryLocalModelServer: nothing local answers -> null and the config is untouched', async () => {
  const cfg = bareConfig({ llmUrl: 'http://127.0.0.1:8080/v1' });
  const r = await tryLocalModelServer(cfg, { setModel: true, probe: async () => null });
  assert.equal(r, null);
  assert.equal(cfg.inferenceMode, 'auto');
  assert.equal(cfg.llmUrl, 'http://127.0.0.1:8080/v1');
});

test('tryLocalModelServer: offline adopts the listed model when none is configured', async () => {
  const cfg = bareConfig({ offline: true, llmUrl: 'http://127.0.0.1:8080/v1' });
  const r = await tryLocalModelServer(cfg, { setModel: true, probe: async (u) => (u.includes(':8080') ? 'bonsai' : null) });
  assert.equal(r?.url, 'http://127.0.0.1:8080/v1');
  assert.equal(cfg.model, 'bonsai');
});
