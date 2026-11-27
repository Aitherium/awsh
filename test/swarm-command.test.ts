import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSwarmArgs, runSwarmCommand } from '../src/swarm-command.js';
import { runDoctor } from '../src/doctor.js';

describe('awsh swarm CLI', () => {
  it('parses subcommands, positional text, and flags cleanly', () => {
    const p = parseSwarmArgs(['launch', 'Build', 'bridge', '--leads', 'atlas,demi', '--title', 'Bridge', '--json']);
    assert.ok(p);
    assert.equal(p.action, 'launch');
    assert.deepEqual(p.positional, ['Build', 'bridge']);
    assert.equal(p.flags.leads, 'atlas,demi');
    assert.equal(p.flags.title, 'Bridge');
    assert.equal(p.json, true);
    assert.equal(parseSwarmArgs(['unknown-verb']), null);
  });

  it('refuses fail-closed when harness token is missing', async () => {
    const errs: string[] = [];
    let called = false;
    const rc = await runSwarmCommand(['list'], {
      hasToken: () => false,
      api: async () => { called = true; return {} as any; },
      err: (s) => errs.push(s),
    });
    assert.equal(rc, 1);
    assert.equal(called, false);
    assert.match(errs.join('\n'), /fail-closed/i);
  });

  it('routes list, status, launch, steer, pause, delegate, and capacity', async () => {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const logs: string[] = [];
    const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({
        path,
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path.startsWith('/swarms/capacity')) {
        return { node: 'devbox', swarm_harnesses: ['claude', 'codex'], ui_url: 'https://app.aitherium.com/swarm', auth_configured: true } as T;
      }
      if (path === '/swarms' && init?.method === 'POST') {
        return { swarm_id: 'swm_0001', title: 'Bridge', status: 'live', ui_url: 'https://app.aitherium.com/swarm?id=swm_0001' } as T;
      }
      if (path.endsWith('/steer')) return { ok: true, seq: 4 } as T;
      if (path.endsWith('/pause')) return { ok: true, status: 'paused' } as T;
      if (path.endsWith('/delegate-harness')) {
        return { ok: true, session_id: 'sess_9', agent: 'demiurge', ui_url: 'https://app.aitherium.com/swarm?id=swm_0001' } as T;
      }
      if (path.startsWith('/swarms/swm_0001')) {
        return { swarm_id: 'swm_0001', title: 'Bridge', status: 'live', overview: { progress: { done: 1, total: 2 } }, ui_url: 'https://app.aitherium.com/swarm?id=swm_0001' } as T;
      }
      return { swarms: [{ swarm_id: 'swm_0001', status: 'live', title: 'Bridge' }], capacity: { swarm_harnesses: ['claude'] } } as T;
    };
    const deps = { hasToken: () => true, api, log: (s: string) => logs.push(s), cwd: '/tmp/work' };

    assert.equal(await runSwarmCommand(['list', '--status', 'live'], deps), 0);
    assert.equal(await runSwarmCommand(['status', 'swm_0001'], deps), 0);
    assert.equal(await runSwarmCommand(['launch', 'Build', 'bridge', '--leads', 'atlas,demi'], deps), 0);
    assert.equal(await runSwarmCommand(['steer', 'swm_0001', 'Focus', 'tests'], deps), 0);
    assert.equal(await runSwarmCommand(['pause', 'swm_0001', '--reason', 'review'], deps), 0);
    assert.equal(await runSwarmCommand(['delegate', 'swm_0001', '--harness', 'codex', '--agent', 'demiurge', 'Fix', 'timeout'], deps), 0);
    assert.equal(await runSwarmCommand(['capacity'], deps), 0);
    assert.equal(await runSwarmCommand(['capacity', '--no-probe'], deps), 0);

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      [
        'GET /swarms?status=live',
        'GET /swarms/swm_0001',
        'POST /swarms',
        'POST /swarms/swm_0001/steer',
        'POST /swarms/swm_0001/pause',
        'POST /swarms/swm_0001/delegate-harness',
        'GET /swarms/capacity?probe=true',
        'GET /swarms/capacity?probe=false',
      ],
    );
    assert.deepEqual(calls[2].body.leads, ['atlas', 'demi']);
    assert.equal(calls[5].body.harness, 'codex');
    assert.equal(calls[5].body.prompt, 'Fix timeout');
  });

  it('reports local swarm-capacity in awsh doctor when harness /health answers', async () => {
    const rep = await runDoctor({
      nodeVersion: 'v20.19.2',
      env: {},
      home: '/home/test',
      platform: 'linux',
      loadConfig: () => ({ values: {}, sources: {}, layers: [], unreadable: [] }),
      getJson: async (url: string) => {
        if (url.endsWith('/health')) {
          return {
            status: 200,
            body: {
              ok: true,
              swarm_capacity: {
                swarms_endpoint: '/swarms',
                ui_url: 'https://app.aitherium.com/swarm',
                swarm_harnesses: ['claude', 'codex', 'gemini'],
              },
            },
          };
        }
        return { status: 200, body: { data: [{ id: 'qwen' }] } };
      },
      listeners: async () => [{ address: '127.0.0.1', port: 8362 }],
      fileMode: () => 0o600,
    });
    const sw = rep.checks.find((c) => c.id === 'swarm-capacity');
    assert.ok(sw);
    assert.equal(sw.ok, true);
    assert.match(sw.detail, /claude, codex, gemini/);
    assert.match(sw.detail, /https:\/\/app\.aitherium\.com\/swarm/);
  });
});
