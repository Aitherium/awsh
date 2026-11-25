/**
 * `aither listen` and `aither registry`.
 *
 * What must hold:
 *  - the first line is the state, lists stop at five with a real "+N more", the last
 *    line is exactly one `Next:`;
 *  - nothing is read as "listening" unless the mic is on AND open, or clipboard sync is on;
 *  - a change goes through the desk's own command, only when the state differs, and
 *    leaves an audit line with who / what / old / new;
 *  - the registry views answer from the two published files and never invent an add.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  capList, formatHearing, hearingRows, registryAgent, registryCan, registryCatalogue,
  registryOverview, runListenCommand, runRegistryCommand, type HearingSources,
} from '../src/controls-command.js';

const src = (input: object = {}, overlay: object = {}, clipboard: object = {}): HearingSources => ({
  cast: { input, overlay, clipboard }, castPath: 'cast.json', posture: { desired: 'shop' },
  paired: 1,
});

test('capList caps presentation and reports the real remainder', () => {
  assert.deepEqual(capList([1, 2, 3, 4, 5, 6, 7]), { shown: [1, 2, 3, 4, 5], more: 2 });
  assert.deepEqual(capList([1]), { shown: [1], more: 0 });
});

test('a muted mic is not listening; an open unmuted mic is', () => {
  const quiet = hearingRows(src({ micMuted: true, talkMode: 'open' }));
  assert.equal(quiet.filter(r => r.listening).length, 0);
  const open = hearingRows(src({ micMuted: false, talkMode: 'open' }));
  assert.deepEqual(open.filter(r => r.listening).map(r => r.key), ['mic', 'talk']);
  const push = hearingRows(src({ micMuted: false, talkMode: 'toggle' }));
  assert.equal(push.filter(r => r.listening).length, 0);
});

test('no desk settings reads as unknown, never as off', () => {
  const rows = hearingRows({ cast: null, castPath: 'x', posture: null, paired: null });
  assert.equal(rows.find(r => r.key === 'mic')!.value, 'unknown');
  assert.equal(rows.find(r => r.key === 'posture')!.value, 'unknown');
});

test('listen: state first, five rows, +N more, one Next', () => {
  const lines = formatHearing(hearingRows(src({ micMuted: true })));
  assert.match(lines[0], /^Aither hears only what you address to her \(0 of 8/);
  assert.equal(lines.filter(l => /^\d\. /.test(l)).length, 5);
  assert.ok(lines.includes('+3 more (aither listen --all)'));
  assert.equal(lines.filter(l => l.startsWith('Next:')).length, 1);
  assert.ok(lines[lines.length - 1].startsWith('Next:'));
  assert.equal(formatHearing(hearingRows(src()), true).filter(l => /^\d\. /.test(l)).length, 8);
});

test('listen mic off runs the desk command once and audits who/what/old/new', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'listen-'));
  const auditPath = join(dir, 'a', 'hearing-audit.jsonl');
  let muted = false;
  const ran: string[] = [];
  const out: string[] = [];
  const code = await runListenCommand(['mic', 'off'], {
    read: () => src({ micMuted: muted }), print: l => out.push(l), auditPath,
    runDesk: async id => { ran.push(id); muted = true; }, now: () => 1_700_000_000_000,
    who: () => 'tester',
  });
  assert.equal(code, 0);
  assert.deepEqual(ran, ['audio.mic.mute']);
  assert.match(out[0], /Desk microphone is now off \(was on\)/);
  assert.deepEqual(JSON.parse(readFileSync(auditPath, 'utf8').trim()), {
    at: 1_700_000_000, by: 'tester', via: 'awsh', what: 'mic', old: 'on', new: 'off',
    confirmed: true,
  });
});

test('listen: an already-set switch runs nothing; a dead desk names the remedy', async () => {
  const ran: string[] = [];
  const out: string[] = [];
  assert.equal(await runListenCommand(['dnd', 'off'], {
    read: () => src({}, { doNotDisturb: false }), print: l => out.push(l),
    runDesk: async id => { ran.push(id); },
  }), 0);
  assert.deepEqual(ran, []);
  assert.match(out[0], /already off/);
  const dead: string[] = [];
  assert.equal(await runListenCommand(['mic', 'off'], {
    read: () => src({ micMuted: false }), print: l => dead.push(l),
    runDesk: async () => { throw new Error('connect ECONNREFUSED'); },
    auditPath: join(mkdtempSync(join(tmpdir(), 'listen-')), 'x.jsonl'),
  }), 1);
  assert.match(dead[0], /not changed: connect ECONNREFUSED - is the desk running/);
  assert.equal(await runListenCommand(['screen', 'on'], { print: () => {} }), 2);
});

const REG = {
  counts: { agents: 7, agents_in_roster: 6, tools: 3, skills: 1, catalogue: 3, phantom_grants: 1 },
  agents: Object.fromEntries(['aither', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => [n, {
    role: 'specialist', family: 'core', in_roster: n !== 'g', tool_count: n === 'aither' ? 2 : i,
    tools: n === 'aither' ? ['send_email', 'web_search'] : [], tool_profile: ['web'],
    advertised_skills: [{ id: 'answer', description: 'Answers' }], settings: { effort_cap: 8 },
    permissions: { has_token_profile: true, grants: ['mcp.send_email:execute'], denies: [] },
    phantom_grants: n === 'aither' ? ['send_emial'] : [], declared_not_granted: [],
  }])),
  harness_agents: { hydra: { description: 'Reviews', tools: ['Read'], path: '.claude/agents/hydra.md' } },
  tools: {
    send_email: { description: 'Send one email.', owner: 'mcp_mail' },
    web_search: { description: 'Search the web.', owner: 'mcp_web' },
    delete_all: { description: 'Delete it all.', owner: 'mcp_x' },
  },
  skills: { thing: { kind: 'harness', description: 'Does a thing with email' } },
  catalogue: {
    awhello: { kind: 'brick', description: 'Says hello', add: 'pip install awhello' },
    awhere: { kind: 'brick', description: 'Already here', add: 'pip install awhere' },
    'integration:toys': { kind: 'integration', name: 'Toys', description: 'A third-party tool',
      add: '', missing: 'nothing installs it' },
  },
};
const USAGE = {
  window_days: 30, installed: ['awhere'],
  tools: { send_email: { calls: 6, failures: 4, last_used: 1_700_000_000 } },
  flags: { tools_measured: true, skills_measured: false, tools_called: 1, tools_total: 3,
    failing_tools: [{ tool: 'send_email', calls: 6, failures: 4, rate: 0.667 }],
    dead_tools: ['web_search'], skills_never_loaded: null },
};

test('registry overview: Aither first, five then the real total, usage flags, one Next', () => {
  const lines = registryOverview(REG, USAGE);
  assert.match(lines[0], /^Registry: 7 agents \(6 in the roster\), 3 tools/);
  assert.match(lines[1], /^1\. aither /);
  assert.ok(lines.includes('+2 more (of 7; aither registry --full)'));
  assert.ok(lines.some(l => l.includes('1 failing (>20% errors), 1 granted and never called')));
  assert.ok(lines.some(l => l === 'Skills never loaded: not measured (transcripts were read only in part).'));
  assert.equal(lines.filter(l => l.startsWith('Next:')).length, 1);
  assert.ok(registryOverview(REG, null).some(l => l.startsWith('Usage: not measured')));
});

test('registry <agent>: tools with usage, what to fix; an unknown name is a remedy', () => {
  const { code, lines } = registryAgent(REG, USAGE, 'aither', false, 1_700_000_000);
  assert.equal(code, 0);
  assert.match(lines[0], /^aither \(specialist, core\): can call 2 of 3 tools; in the roster\./);
  assert.match(lines[1], /^1\. Tools: send_email \(6 calls, 4 failed, last today\), web_search$/);
  assert.match(lines[5], /1 grants name a tool that does not exist \(send_emial\)/);
  assert.ok(lines[lines.length - 1].startsWith('Next:'));
  assert.equal(registryAgent(REG, null, 'hydra').code, 0);
  const miss = registryAgent(REG, null, 'aith');
  assert.equal(miss.code, 1);
  assert.match(miss.lines[0], /did you mean aither/);
});

test('registry can: names who is granted the tool', () => {
  const { code, lines } = registryCan(REG, 'send email');
  assert.equal(code, 0);
  assert.match(lines[1], /^1\. tool send_email - Send one email\. Who: aither \(1 agents\)/);
  assert.equal(registryCan(REG, 'launch rocket').code, 1);
});

test('registry catalogue: installed / available / not addable yet, with the one-step add', () => {
  const { lines } = registryCatalogue(REG, USAGE, '');
  assert.match(lines[0], /^Catalogue: 3 of 3 entries; 1 can be added in one step, 1 installed here\./);
  assert.match(lines[1], /^1\. awhello \[available\] - Says hello {2}Add: pip install awhello$/);
  assert.ok(lines.some(l => l.includes('awhere [installed]')));
  assert.ok(lines.some(l => l.includes('Toys [not addable yet]') && l.includes('(nothing installs it)')));
  assert.equal(lines[lines.length - 1], 'Next: pip install awhello');
  assert.match(registryCatalogue(REG, null, 'hello').lines[0], /installed state: not checked/);
});

test('registry without the published files answers with the one command that makes them', async () => {
  const out: string[] = [];
  const code = await runRegistryCommand([], {
    read: () => ({ registry: null, usage: null, dir: '/h/.aither/registry' }),
    print: l => out.push(l),
  });
  assert.equal(code, 1);
  assert.match(out[0], /No registry on this machine yet .* Next: from the repo, run `python /);
});
