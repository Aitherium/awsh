/**
 * The ONE next action: priority, the five-row cap, and the remedy always inline.
 *
 * Each arm pins a defect visible in the owner's 2026-11-01 awsh screenshot: a boot
 * screen that said `10 down` with no verb, a status bar that named an ask by id only,
 * and a screen with 130 waiting asks and no single line telling anyone where to start.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEXT_VISIBLE, computeNextAction, type NextAsk } from '../src/next-action.ts';

const ask = (over: Partial<NextAsk> = {}): NextAsk => ({
  id: 'd-aaaa', title: 'Publish the brief', ageSec: 600, hot: false, ...over,
});

const base = { down: [] as string[], total: 0, asks: [] as NextAsk[], askCount: 0 };

test('one hot ask leads with the verb and the id, not a count', () => {
  // Mutation: return verb 'review'/a bare "1 waiting" -> this fails.
  const plan = computeNextAction({ ...base, asks: [ask({ id: 'd-ts7e', title: 'Election Day is Tuesday', hot: true })], askCount: 1 });
  assert.equal(plan.verb, 'answer');
  assert.equal(plan.line, 'answer d-ts7e — Election Day is Tuesday');
});

test('without a hot ask the one that has waited longest leads', () => {
  const plan = computeNextAction({
    ...base,
    asks: [ask({ id: 'd-new', title: 'new', ageSec: 30 }), ask({ id: 'd-old', title: 'old', ageSec: 9000 })],
    askCount: 2,
  });
  assert.equal(plan.verb, 'answer');
  assert.match(plan.line, /^answer d-old/);
});

test('seven asks show five numbered rows and count the rest — never drop it', () => {
  // Doctrine law 4: cap presentation, never data. Mutation: slice(0, 7) or no `more`.
  const asks = Array.from({ length: 7 }, (_, i) => ask({ id: `d-${i}`, title: `task ${i}`, ageSec: 100 + i }));
  const plan = computeNextAction({ ...base, asks, askCount: 7 });
  assert.equal(plan.items.length, NEXT_VISIBLE);
  assert.equal(plan.items.length, 5);
  assert.deepEqual(plan.items.map((i) => i.n), [1, 2, 3, 4, 5]);
  assert.equal(plan.items[0].label, 'd-0 task 0');
  assert.equal(plan.more, 2);
});

test('an older ask that is not headlined still counts in `more`', () => {
  // rankBeam().fresh holds only the last day; .open holds everything still waiting.
  const plan = computeNextAction({ ...base, asks: [ask({ id: 'd-1' }), ask({ id: 'd-2' })], askCount: 9 });
  assert.equal(plan.items.length, 2);
  assert.equal(plan.more, 7);
});

test('eleven services with ten down lead with the count AND the remedy', () => {
  // The screenshot's exact failure: "10 down" and nothing to type next.
  const down = ['Pulse', 'Strata', 'Identity', 'Node', 'Secrets', 'Chronicle', 'Perception',
    'ComfyUI', 'MediaForge', 'Genesis'];
  const plan = computeNextAction({ ...base, down, total: 11 });
  assert.equal(plan.verb, 'run');
  assert.match(plan.line, /10 down/);
  assert.match(plan.line, /\/doctor/);
  assert.match(plan.line, /Pulse, Strata, Identity/);
  assert.doesNotMatch(plan.line, /Node/);      // names the first three, not all ten
});

test('a person waiting outranks a fleet that is down', () => {
  const plan = computeNextAction({ ...base, down: ['Pulse'], total: 11, asks: [ask({ hot: true })], askCount: 1 });
  assert.equal(plan.verb, 'answer');
});

test('no FRESH ask but open asks still leads with /decide, never "nothing waiting"', () => {
  // `rankBeam().fresh` is only the last day; `.open` is everything still waiting.
  // The owner's screenshot: 130 waiting, 60 older than 7 days. With asks=[] the old
  // code fell through to "nothing waiting" while the strip said 130. Mutation: drop
  // the askCount branch -> this fails.
  const plan = computeNextAction({ ...base, asks: [], askCount: 130 });
  assert.equal(plan.verb, 'run');
  assert.match(plan.line, /130 waiting/);
  assert.match(plan.line, /\/decide/);
});

test('a down fleet still outranks an OLD (non-fresh) ask count', () => {
  // rankBeam's own rule: past 24h an ask is "counted, never headlined". A concrete
  // repair stays the next action; the count is restated on the strip and prompt.
  const plan = computeNextAction({ ...base, down: ['Pulse'], total: 11, asks: [], askCount: 130 });
  assert.equal(plan.verb, 'run');
  assert.match(plan.line, /1 down/);
  assert.match(plan.line, /\/doctor/);
});

test('older asks keep their count in `more` even with no numbered rows', () => {
  const plan = computeNextAction({ ...base, asks: [], askCount: 130 });
  assert.equal(plan.items.length, 0);
  assert.equal(plan.more, 130);
});

test('critical cards, then the house schedule, then nothing', () => {
  const crit = computeNextAction({ ...base, critical: { total: 4, titles: ['x'] } });
  assert.equal(crit.verb, 'run');
  assert.equal(crit.line, '/actions — 4 critical');

  const house = computeNextAction({ ...base, postureNext: 'Shop open at 09:00' });
  assert.equal(house.verb, 'review');
  assert.match(house.line, /Shop open at 09:00/);
  assert.match(house.line, /\/posture/);

  const idle = computeNextAction(base);
  assert.equal(idle.verb, 'none');
  assert.equal(idle.line, 'nothing waiting — describe the task');
  assert.equal(idle.more, 0);
});

test('a zero critical count is not an action', () => {
  const plan = computeNextAction({ ...base, critical: { total: 0, titles: [] } });
  assert.equal(plan.verb, 'none');
});
