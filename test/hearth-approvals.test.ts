/**
 * `awsh hearth` and the after-turn notice (src/hearth-approvals.ts).
 * 2026-10-13: a card raised from an omnibox line surfaced only on the phone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runHearthCommand, printNewPendingAfterTurn, parseToolResult, pendingLines } =
  await import('../src/hearth-approvals.ts');

const URL_ = 'https://www.helpnetsecurity.com/2026/10/07/tanium-security-operations/';
const CARD = { code: '9c424891', summary: `open ${URL_}`, detail: { url: URL_ } };

function fake(pending = [CARD], answer: any = {
  ok: true, ran: true, tool: 'hearth_web_fetch',
  result: { untrusted: true, data: { status: 200, url: URL_, text: 'Tanium launches an agentic SOC' } },
}) {
  const calls: Array<[string, any]> = [];
  const call = async (name: string, args: any) => {
    calls.push([name, args]);
    if (name === 'hearth_status') return { pending_approvals: pending };
    if (name === 'hearth_approve') return answer;
    throw new Error(name);
  };
  return { calls, call };
}

function io(over: Partial<{ isTTY: boolean; typed: string }> = {}, f = fake()) {
  const lines: string[] = [];
  return {
    lines, f,
    io: { call: f.call, out: (l: string) => lines.push(l), isTTY: over.isTTY ?? true,
          ask: async () => over.typed ?? 'yes' },
  };
}

test('pending lists the card with the exact lines that answer it', async () => {
  const t = io();
  assert.equal(await runHearthCommand([], t.io), 0);
  const all = t.lines.join('\n');
  assert.match(all, /9c424891/);
  assert.match(all, /awsh hearth approve 9c424891/);
  assert.match(all, /awsh hearth deny 9c424891/);
});

test('approve shows the card, needs "yes", and answers hearth_approve once with that code', async () => {
  const t = io();
  assert.equal(await runHearthCommand(['approve', '9c424891'], t.io), 0);
  const approves = t.f.calls.filter(([n]) => n === 'hearth_approve');
  assert.deepEqual(approves, [['hearth_approve', { code: '9c424891', allow: true }]]);
  const all = t.lines.join('\n');
  assert.ok(all.includes(URL_), 'shows the exact URL it opened');
  assert.ok(!all.includes('example.com'));
});

test('approve without a person at a terminal runs nothing', async () => {
  const t = io({ isTTY: false });
  assert.equal(await runHearthCommand(['approve', '9c424891'], t.io), 2);
  assert.equal(t.f.calls.filter(([n]) => n === 'hearth_approve').length, 0);
});

test('anything but "yes" leaves the card waiting', async () => {
  const t = io({ typed: 'y' });
  assert.equal(await runHearthCommand(['approve', '9c424891'], t.io), 1);
  assert.equal(t.f.calls.filter(([n]) => n === 'hearth_approve').length, 0);
});

test('deny needs no prompt and sends allow=false', async () => {
  const t = io({ isTTY: false }, fake([CARD], { ok: true, ran: false }));
  assert.equal(await runHearthCommand(['deny', '9c424891'], t.io), 0);
  assert.deepEqual(t.f.calls.at(-1), ['hearth_approve', { code: '9c424891', allow: false }]);
});

test('a code that is not waiting is refused without calling hearth_approve', async () => {
  const t = io({}, fake([]));
  assert.equal(await runHearthCommand(['approve', 'deadbeef'], t.io), 1);
  assert.equal(await runHearthCommand(['approve', 'not-a-code'], t.io), 2);
  assert.equal(t.f.calls.filter(([n]) => n === 'hearth_approve').length, 0);
});

test('after a turn, only cards that turn created are printed', async () => {
  const older = { code: 'c78b45d8', summary: 'open https://old.example' };
  const f = fake([older, CARD]);
  const out: string[] = [];
  await printNewPendingAfterTurn(f.call, Promise.resolve([older]), (l) => out.push(l));
  const all = out.join('\n');
  assert.match(all, /9c424891/);
  assert.doesNotMatch(all, /c78b45d8/);
});

test('a Hearth that cannot be read prints nothing and does not throw', async () => {
  const out: string[] = [];
  await printNewPendingAfterTurn(async () => { throw new Error('down'); }, Promise.resolve(null),
    (l) => out.push(l));
  assert.deepEqual(out, []);
  assert.deepEqual(pendingLines([]), []);
});

test('parseToolResult reads text content and surfaces a tool error', () => {
  assert.deepEqual(parseToolResult({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  assert.throws(() => parseToolResult({ isError: true, content: [{ type: 'text', text: 'nope' }] }), /nope/);
});
