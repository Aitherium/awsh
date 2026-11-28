import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCapacity,
  formatSwarmBoard,
  formatSwarmList,
  formatSwarmStatus,
  parseSwarmArgs,
  runSwarmCommand,
} from '../src/swarm-command.js';
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

  it('supports --local Room mode across launch, list, delegate, and post', async () => {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const logs: string[] = [];
    const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({
        path,
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path.startsWith('/swarms?')) {
        return {
          swarms: [{ swarm_id: 'sw_local_1', status: 'live', local_room: true, progress: { done: 1, total: 3 }, title: 'Local' }],
          capacity: { node: 'devbox', swarm_harnesses: ['claude'], awrun_available: true },
        } as T;
      }
      if (path === '/swarms' && init?.method === 'POST') {
        return { swarm_id: 'sw_local_1', status: 'live', local_room: true, progress: { done: 0, total: 2 } } as T;
      }
      if (path.endsWith('/delegate-harness')) {
        return { ok: true, session_id: 'sess_loc', slot_id: 'fix-1', agent: 'demiurge', ui_url: '' } as T;
      }
      return { ok: true, seq: 2 } as T;
    };
    const deps = { hasToken: () => true, api, log: (s: string) => logs.push(s), cwd: '/tmp/work' };

    assert.equal(await runSwarmCommand(['launch', 'Local', 'swarm', '--local', '--room-id', 'swarm-custom'], deps), 0);
    assert.equal(await runSwarmCommand(['list', '--local'], deps), 0);
    assert.equal(
      await runSwarmCommand(['delegate', 'sw_local_1', '--harness', 'claude', '--slot', 'fix-1', '--local', '--no-keep-warm', 'Run'], deps),
      0,
    );
    assert.equal(await runSwarmCommand(['post', 'sw_local_1', 'Status', 'ok', '--local'], deps), 0);

    assert.equal(calls[0].body.local_only, true);
    assert.equal(calls[0].body.local_room, true);
    assert.equal(calls[0].body.mode, 'local');
    assert.equal(calls[0].body.room_id, 'swarm-custom');
    assert.equal(calls[1].path, '/swarms?local_only=true');
    assert.match(logs[1], /\[local\] \(1\/3\)/);
    assert.match(logs[1], /awrun: on/);
    assert.equal(calls[2].body.local_only, true);
    assert.equal(calls[2].body.local_room, true);
    assert.equal(calls[2].body.keep_warm, false);
    assert.equal(calls[3].body.local_only, true);
  });

  it('routes board, post, steer --mentions, and nudge with both local and Genesis schemas', async () => {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const logs: string[] = [];
    const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({
        path,
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path.includes('/board')) {
        return {
          swarm_id: 'sw_1',
          head: 2,
          posts: [
            { seq: 1, slot_id: 'fix-1', kind: 'done', mentions: ['verifier'], seal: { scheme: 'awseal-ed25519', verified: true }, text: 'Done' },
          ],
        } as T;
      }
      if (path.endsWith('/post')) {
        return { ok: true, seq: 3, seal: { scheme: 'awseal-ed25519', verified: true } } as T;
      }
      if (path.endsWith('/steer')) return { ok: true, seq: 4 } as T;
      if (path.endsWith('/nudge')) return { ok: true, action: 'nudged', slot_id: 'fix-1', escalated: false } as T;
      return {} as T;
    };
    const deps = { hasToken: () => true, api, log: (s: string) => logs.push(s) };

    assert.equal(await runSwarmCommand(['board', 'sw_1', '--since', '0', '--limit', '20'], deps), 0);
    assert.equal(
      await runSwarmCommand([
        'post', 'sw_1', '@verifier', '[done]', 'Ready',
        '--agent', 'fix-1', '--slot-id', 'fix-1', '--kind', 'done',
        '--mentions', 'verifier', '--thread', 'th_1',
        '--artifact-dir', '/tmp/art', '--seal-artifacts',
        '--awseal-expect-key', 'abcd1234', '--key-path', '/tmp/k.key',
      ], deps),
      0,
    );
    assert.equal(await runSwarmCommand(['steer', 'sw_1', 'Prioritize', 'tests', '--mentions', '@fix-1,fix-2'], deps), 0);
    assert.equal(await runSwarmCommand(['nudge', 'sw_1', 'fix-1', 'Stalled', 'on', 'build', '--escalate-after', '15', '--force-escalate'], deps), 0);

    assert.equal(calls[0].path, '/swarms/sw_1/board?since=0&limit=20');
    assert.match(logs[0], /#1 \[done\] fix-1 -> @verifier \[seal:awseal-ed25519 ok\]: Done/);
    assert.equal(calls[1].body.kind, 'done');
    assert.deepEqual(calls[1].body.mentions, ['verifier']);
    assert.equal(calls[1].body.artifact_dir, '/tmp/art');
    assert.equal(calls[1].body.seal_artifacts, true);
    assert.equal(calls[1].body.awseal_expect_key, 'abcd1234');
    assert.equal(calls[1].body.expect_key, 'abcd1234');
    assert.equal(calls[1].body.key_path, '/tmp/k.key');
    assert.deepEqual(calls[2].body.mentions, ['fix-1', 'fix-2']);
    assert.equal(calls[3].body.slot_id, 'fix-1');
    assert.equal(calls[3].body.reason, 'Stalled on build');
    assert.equal(calls[3].body.escalate_after_s, 15);
    assert.equal(calls[3].body.force_escalate, true);

    // Genesis board schema (`messages`) also formats cleanly
    const genBoard = formatSwarmBoard({
      swarm_id: 'sw_gen',
      head: 5,
      messages: [{ seq: 5, agent: 'atlas', kind: 'brief', text: 'Track brief' }],
    });
    assert.match(genBoard, /#5 \[brief\] atlas: Track brief/);
  });

  it('supports F6 named workers, pools, owns, must_not_touch, worktree, leases, and rich status formatting', async () => {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const logs: string[] = [];
    const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === '/swarms' && init?.method === 'POST') {
        return {
          swarm_id: 'sw_pool',
          status: 'live',
          local_room: true,
          progress: { done: 1, total: 3 },
          members: [
            {
              slot_id: 'fix-1',
              session_state: 'awake',
              pool: 'fix',
              owns: ['a.py'],
              must_not_touch: ['b.py'],
              sibling_digests: [{ slot_id: 'fix-2' }],
              worktree_path: '/tmp/wt/fix-1',
              lease_ids: ['lease-1'],
              execution_mode: 'awrun',
              run_id: 'r-1234',
              inference_runtime: 'awzeal',
              shared_ro_mmap: true,
              shared_ro_mode: 'D5_shared_ro',
              cpu_pin: '0-3',
            },
          ],
          threads: [
            {
              id: 'th_1',
              slot_id: 'fix-1',
              status: 'moving',
              pool: 'fix',
              owns: ['a.py'],
              must_not_touch: ['b.py'],
              sibling_digests: [{ slot_id: 'fix-2' }],
              worktree_path: '/tmp/wt/fix-1',
              lease_id: 'lease-1',
              run_id: 'r-1234',
              inference_runtime: 'awzeal',
              shared_ro_mmap: true,
              cpu_pin: '0-3',
            },
          ],
        } as T;
      }
      return { ok: true, session_id: 's_1', slot_id: 'fix-1', worktree_path: '/tmp/wt/fix-1', lease_ids: ['l1'], run_id: 'r-1' } as T;
    };
    const deps = { hasToken: () => true, api, log: (s: string) => logs.push(s), cwd: '/repo' };

    assert.equal(
      await runSwarmCommand([
        'launch', 'Pool', 'fix',
        '--workers', '[{"slot_id":"api-dev","agent":"demiurge"}]',
        '--pools', 'fix=3',
        '--owns', 'src/a.py,src/b.py',
        '--must-not-touch', 'src/c.py',
        '--worktree', '--leases',
      ], deps),
      0,
    );
    assert.equal(
      await runSwarmCommand([
        'delegate', 'sw_pool',
        '--harness', 'claude', '--agent', 'demiurge',
        '--slot-id', 'fix-1', '--member-id', 'fix-1', '--pool', 'fix',
        '--owns', 'src/a.py', '--must-not-touch', 'src/b.py',
        '--worktree', '--leases', '--timeout', '120',
        'Fix', 'a.py',
      ], deps),
      0,
    );

    assert.deepEqual(calls[0].body.workers, [
      { slot_id: 'api-dev', agent: 'demiurge', owns: ['src/a.py', 'src/b.py'], must_not_touch: ['src/c.py'] },
    ]);
    assert.deepEqual(calls[0].body.pools, {
      fix: { count: 3, owns: ['src/a.py', 'src/b.py'], must_not_touch: ['src/c.py'] },
    });
    assert.equal(calls[0].body.use_worktree, true);
    assert.equal(calls[0].body.use_leases, true);

    assert.equal(calls[1].body.slot_id, 'fix-1');
    assert.equal(calls[1].body.member_id, 'fix-1');
    assert.equal(calls[1].body.pool, 'fix');
    assert.deepEqual(calls[1].body.owns, ['src/a.py']);
    assert.deepEqual(calls[1].body.must_not_touch, ['src/b.py']);
    assert.equal(calls[1].body.use_worktree, true);
    assert.equal(calls[1].body.use_leases, true);
    assert.equal(calls[1].body.timeout_s, 120);

    const statusOut = logs[0];
    assert.match(statusOut, /Progress: 1\/3/);
    assert.match(statusOut, /fix-1\(awake;/);
    assert.match(statusOut, /pool=fix/);
    assert.match(statusOut, /owns=a\.py/);
    assert.match(statusOut, /must_not_touch=b\.py/);
    assert.match(statusOut, /wt=\/tmp\/wt\/fix-1/);
    assert.match(statusOut, /leases=lease-1/);
    assert.match(statusOut, /run=r-1234/);
    assert.match(statusOut, /rt=awzeal/);
    assert.match(statusOut, /D5_shared_ro/);

    const listOut = formatSwarmList({
      swarms: [{ swarm_id: 'sw_local', status: 'live', local_room: true, progress: { done: 2, total: 5 }, title: 'T' }],
    });
    assert.match(listOut, /sw_local\s+\[live\] \[local\] \(2\/5\)/);
  });

  it('supports F16 flags, invalid JSON exit code 2, pause --export-runs, and capacity F16 formatting', async () => {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const logs: string[] = [];
    const errs: string[] = [];
    const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path.startsWith('/swarms/capacity')) {
        return {
          node: 'spark',
          swarm_harnesses: ['claude'],
          auth_configured: true,
          awrun_available: true,
          awrun_active_runs: ['r-101', 'r-102'],
          awseal_available: true,
          awzeal_available: true,
          supported_inference_runtimes: ['standard', 'asm-llm', 'awzeal'],
        } as T;
      }
      return { swarm_id: 'sw_f16', status: 'paused' } as T;
    };
    const deps = {
      hasToken: () => true,
      api,
      log: (s: string) => logs.push(s),
      err: (s: string) => errs.push(s),
      cwd: '/repo',
    };

    // Invalid JSON -> exit code 2 without API call
    const badRc = await runSwarmCommand(['launch', 'Bad', '--limits', '{not-json'], deps);
    assert.equal(badRc, 2);
    assert.equal(calls.length, 0);
    assert.match(errs.join('\n'), /Invalid JSON for --limits/);

    assert.equal(
      await runSwarmCommand([
        'launch', 'F16', 'run',
        '--execution-mode', 'awrun',
        '--limits', '{"cpus":2,"memory_mb":512}',
        '--egress', 'api.github.com,pypi.org',
        '--isolation', '{"mode":"container","image":"aither:1"}',
        '--awseal-expect-key', 'deadbeef',
        '--seal-artifacts',
        '--inference-runtime', 'awzeal',
        '--shared-ro-mmap',
        '--model-path', '/models/bonsai.pq2',
        '--model-sha256', 'aaaa',
        '--cpu-pin', '0-7',
      ], deps),
      0,
    );
    assert.equal(
      await runSwarmCommand([
        'delegate', 'sw_f16', '--harness', 'aither',
        '--execution-mode', 'awrun',
        '--limits', '{"cpus":1}',
        '--egress', '{"hosts":[]}',
        '--isolation', '{"mode":"container","image":"aither:1"}',
        '--inference-runtime', 'asm-llm',
        '--shared-ro-mmap',
        '--model-path', '/models/q.asm',
        '--model-sha256', 'bbbb',
        '--cpu-pin', '4-7',
        'Run', 'confined',
      ], deps),
      0,
    );
    assert.equal(await runSwarmCommand(['pause', 'sw_f16', '--export-runs', '--export-dir', '/tmp/exp'], deps), 0);
    assert.equal(await runSwarmCommand(['capacity', '--no-probe'], deps), 0);

    assert.equal(calls[0].body.execution_mode, 'awrun');
    assert.deepEqual(calls[0].body.limits, { cpus: 2, memory_mb: 512 });
    assert.deepEqual(calls[0].body.egress, { hosts: ['api.github.com', 'pypi.org'] });
    assert.deepEqual(calls[0].body.isolation, { mode: 'container', image: 'aither:1' });
    assert.equal(calls[0].body.awseal_expect_key, 'deadbeef');
    assert.equal(calls[0].body.seal_artifacts, true);
    assert.equal(calls[0].body.inference_runtime, 'awzeal');
    assert.equal(calls[0].body.shared_ro_mmap, true);
    assert.equal(calls[0].body.model_path, '/models/bonsai.pq2');
    assert.equal(calls[0].body.model_sha256, 'aaaa');
    assert.equal(calls[0].body.cpu_pin, '0-7');

    assert.equal(calls[1].body.execution_mode, 'awrun');
    assert.deepEqual(calls[1].body.egress, { hosts: [] });
    assert.equal(calls[1].body.inference_runtime, 'asm-llm');
    assert.equal(calls[1].body.shared_ro_mmap, true);

    assert.equal(calls[2].body.export_runs, true);
    assert.equal(calls[2].body.export_dir, '/tmp/exp');

    const capText = formatCapacity({
      node: 'spark',
      swarm_harnesses: ['claude'],
      auth_configured: true,
      awrun_available: true,
      awrun_active_runs: ['r-101', 'r-102'],
      awseal_available: true,
      awzeal_available: true,
      supported_inference_runtimes: ['standard', 'asm-llm', 'awzeal'],
    });
    assert.match(capText, /awrun=yes \(active runs: 2 \(r-101, r-102\)\)/);
    assert.match(capText, /awseal=yes \| awzeal=yes/);
    assert.match(capText, /standard, asm-llm, awzeal/);
    assert.equal(typeof formatSwarmStatus({ swarm_id: 'x' }), 'string');
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

  it('handles --local=false, rejects --local/--cloud conflicts, and rejects valueless value flags with exit code 2', async () => {
    const calls: Array<{ path: string; method: string; body: any }> = [];
    const errs: string[] = [];
    const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({
        path,
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path === '/swarms' && init?.method === 'POST') {
        return { swarm_id: 'sw_cli_edge', status: 'live', local_only: calls[calls.length - 1].body.local_only } as T;
      }
      if (path.includes('/board')) {
        return { swarm_id: 'sw_1', head: 0, posts: [] } as T;
      }
      if (path.endsWith('/nudge')) {
        return { ok: true, action: 'nudged', slot_id: 'fix-1' } as T;
      }
      return {} as T;
    };
    const deps = {
      hasToken: () => true,
      api,
      log: () => {},
      err: (s: string) => errs.push(s),
      cwd: '/repo',
    };

    // 1. --local=false without --cloud -> local_only: false, no local_room/mode
    assert.equal(await runSwarmCommand(['launch', 'Cloud', 'goal', '--local=false'], deps), 0);
    assert.equal(calls[0].body.local_only, false);
    assert.equal(calls[0].body.local_room, undefined);
    assert.equal(calls[0].body.mode, undefined);

    // 2. --local=false --cloud=true and --local=false --cloud -> local_only: false
    assert.equal(await runSwarmCommand(['launch', 'Cloud', 'goal', '--local=false', '--cloud=true'], deps), 0);
    assert.equal(calls[1].body.local_only, false);
    assert.equal(calls[1].body.local_room, undefined);
    assert.equal(await runSwarmCommand(['launch', 'Cloud', 'goal', '--local=false', '--cloud'], deps), 0);
    assert.equal(calls[2].body.local_only, false);
    assert.equal(calls[2].body.local_room, undefined);

    // 3. --cloud=true without --local -> local_only: false
    assert.equal(await runSwarmCommand(['launch', 'Cloud', 'only', '--cloud=true'], deps), 0);
    assert.equal(calls[3].body.local_only, false);

    // 4. --local=true --cloud=false -> local_only: true, local_room: true, mode: 'local'
    assert.equal(await runSwarmCommand(['launch', 'Local', 'explicit', '--local=true', '--cloud=false'], deps), 0);
    assert.equal(calls[4].body.local_only, true);
    assert.equal(calls[4].body.local_room, true);
    assert.equal(calls[4].body.mode, 'local');

    // 5. Mutually exclusive conflicts -> exit 2 with 0 API calls
    const beforeConflicts = calls.length;
    for (const argv of [
      ['launch', 'Goal', '--local', '--cloud'],
      ['launch', 'Goal', '--local=true', '--cloud=true'],
      ['launch', 'Goal', '--mode', 'local', '--cloud'],
      ['launch', 'Goal', '--local=false', '--mode', 'local'],
      ['launch', 'Goal', '--local=false', '--cloud=false'],
    ]) {
      errs.length = 0;
      const rc = await runSwarmCommand(argv, deps);
      assert.equal(rc, 2, `expected exit 2 for ${argv.join(' ')}`);
      assert.match(errs.join('\n'), /mutually exclusive/i);
    }
    assert.equal(calls.length, beforeConflicts);

    // 6. Valueless VALUE_FLAGS (trailing or followed by --flag) -> exit 2 with 0 API calls
    for (const argv of [
      ['launch', 'Goal', '--limits'],
      ['list', '--status'],
      ['board', 'sw_1', '--since'],
      ['launch', 'Goal', '--limits', '--local'],
      ['launch', 'Goal', '--title', '--json'],
    ]) {
      errs.length = 0;
      const rc = await runSwarmCommand(argv, deps);
      assert.equal(rc, 2, `expected exit 2 for ${argv.join(' ')}`);
      assert.match(errs.join('\n'), /Missing value for --/);
    }
    assert.equal(calls.length, beforeConflicts);
    assert.throws(() => parseSwarmArgs(['launch', 'Goal', '--limits']), /Missing value for --limits/);

    // 7. Negative numeric values and '='-form '--' values remain preserved
    assert.equal(await runSwarmCommand(['board', 'sw_1', '--since', '-1'], deps), 0);
    assert.equal(calls[calls.length - 1].path, '/swarms/sw_1/board?since=0');
    assert.equal(await runSwarmCommand(['nudge', 'sw_1', 'fix-1', '--escalate-after', '-5'], deps), 0);
    assert.equal(calls[calls.length - 1].body.escalate_after_s, -5);
    const eqParsed = parseSwarmArgs(['launch', 'Goal', '--title=--foo']);
    assert.ok(eqParsed);
    assert.equal(eqParsed.flags.title, '--foo');

    // 8. --mode cloud sets local_only=false, local_room=false, mode='cloud'; --local --mode cloud fails exit 2
    assert.equal(await runSwarmCommand(['launch', 'Cloud', 'mode', '--mode', 'cloud'], deps), 0);
    assert.equal(calls[calls.length - 1].body.local_only, false);
    assert.equal(calls[calls.length - 1].body.local_room, false);
    assert.equal(calls[calls.length - 1].body.mode, 'cloud');

    const beforeCloudConflict = calls.length;
    for (const argv of [
      ['launch', 'Goal', '--local', '--mode', 'cloud'],
      ['launch', 'Goal', '--mode', 'cloud', '--cloud=false'],
    ]) {
      errs.length = 0;
      const rc = await runSwarmCommand(argv, deps);
      assert.equal(rc, 2, `expected exit 2 for ${argv.join(' ')}`);
      assert.match(errs.join('\n'), /mutually exclusive/i);
    }
    assert.equal(calls.length, beforeCloudConflict);
  });
});
